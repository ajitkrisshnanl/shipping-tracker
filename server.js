/**
 * Backend Server - Express + WebSocket for vessel tracking
 *
 * Uses AI-powered extraction (Google Gemini 3 Flash with GPT-4o fallback) to parse any Bill of Lading format.
 * Uses live web scraping for vessel tracking (no AIS WebSocket dependency).
 */

const express = require('express')
const cors = require('cors')
const { WebSocketServer } = require('ws')
const http = require('http')
const path = require('path')
const multer = require('multer')
const pdfParse = require('pdf-parse')
const { GoogleGenerativeAI } = require('@google/generative-ai')
const OpenAI = require('openai')
const nodemailer = require('nodemailer')
const { getBottlenecks, checkBottleneckProximity } = require('./bottlenecks')
const { calculateRoute, estimateArrival } = require('./seaRoutes')

// Initialize Gemini client
const genAI = process.env.GEMINI_API_KEY
    ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
    : null

// Initialize OpenAI client (fallback)
const openai = process.env.OPENAI_API_KEY
    ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    : null
const OPENAI_MODELS = [
    process.env.OPENAI_MODEL || 'gpt-5.1',
    process.env.OPENAI_FALLBACK_MODEL || 'gpt-4.1'
]

const app = express()
const PORT = process.env.PORT || 3001

// Middleware
app.use(cors())
app.use(express.json())

// Configure Multer for file uploads
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
})

// In-memory vessel storage
let vesselDatabase = []
const trackedVessels = new Map()
const positionCache = new Map()
const myShipTrackingUrlCache = new Map()
const POSITION_REFRESH_MS = Number(process.env.POSITION_REFRESH_MS || 3600000)
const POSITION_CACHE_TTL_MS = Number(process.env.POSITION_CACHE_TTL_MS || 25000)
const MAX_TRACKED_VESSELS = Number(process.env.MAX_TRACKED_VESSELS || 10)
let positionRefreshTimer = null
let positionRefreshInFlight = false
const SUBSCRIPTIONS_FILE = path.join(__dirname, 'subscriptions.json')
let subscriptions = []
let notificationsTimer = null
const SCRAPE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'text/html'
}

const SMTP_HOST = process.env.SMTP_HOST || null
const SMTP_PORT = Number(process.env.SMTP_PORT || 587)
const SMTP_USER = process.env.SMTP_USER || null
const SMTP_PASS = process.env.SMTP_PASS || null
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER || null
const SMTP_SECURE = (process.env.SMTP_SECURE || '').toLowerCase() === 'true'
const EMAIL_ENABLED = !!(SMTP_HOST && SMTP_USER && SMTP_PASS && SMTP_FROM)

const mailTransporter = EMAIL_ENABLED
    ? nodemailer.createTransport({
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: SMTP_SECURE,
        auth: { user: SMTP_USER, pass: SMTP_PASS }
    })
    : null

function getPositionCacheKey(mmsi, name) {
    if (mmsi) return mmsi.toString()
    if (name) return normalizeName(name)
    return null
}

function getCachedPosition(key) {
    if (!key) return null
    const cached = positionCache.get(key)
    if (!cached) return null
    if (Date.now() - cached.timestamp > POSITION_CACHE_TTL_MS) {
        positionCache.delete(key)
        return null
    }
    return cached.data
}

function setCachedPosition(key, data) {
    if (!key || !data) return
    positionCache.set(key, { data, timestamp: Date.now() })
}

function loadSubscriptions() {
    try {
        const fs = require('fs')
        if (!fs.existsSync(SUBSCRIPTIONS_FILE)) {
            subscriptions = []
            return
        }
        const raw = fs.readFileSync(SUBSCRIPTIONS_FILE, 'utf8')
        const data = JSON.parse(raw)
        subscriptions = Array.isArray(data) ? data : []
    } catch (err) {
        console.error('Failed to load subscriptions:', err.message)
        subscriptions = []
    }
}

function saveSubscriptions() {
    try {
        const fs = require('fs')
        fs.writeFileSync(SUBSCRIPTIONS_FILE, JSON.stringify(subscriptions, null, 2))
    } catch (err) {
        console.error('Failed to save subscriptions:', err.message)
    }
}

function normalizeCadenceHours(input) {
    const hours = Number(input)
    if (!Number.isFinite(hours) || hours <= 0) return 24
    return Math.min(Math.max(hours, 1), 168)
}

function formatPositionLine(vessel) {
    if (!vessel?.latitude || !vessel?.longitude) return 'Current Position: unavailable'
    return `Current Position: ${vessel.latitude.toFixed(4)}, ${vessel.longitude.toFixed(4)}`
}

function formatWeatherLine(weather) {
    if (!weather) return 'Weather: unavailable'
    const wind = `${(weather.wind_speed_10m ?? 0).toFixed(1)} m/s @ ${weather.wind_direction_10m ?? 0}°`
    const wave = weather.wave_height ? `${weather.wave_height.toFixed(2)} m` : 'N/A'
    return `Weather: wind ${wind}, wave height ${wave}`
}

function buildWarningLines(vessel, weather) {
    const warnings = []
    if (vessel?.bottleneckWarning) {
        warnings.push(`Congestion: ${vessel.bottleneckWarning.zone} (+${vessel.bottleneckWarning.delayMinutes} min)`)
    }
    if (weather?.wind_speed_10m && weather.wind_speed_10m >= 15) {
        warnings.push('Weather: high wind conditions')
    }
    if (weather?.wave_height && weather.wave_height >= 3) {
        warnings.push('Weather: high wave height')
    }
    return warnings
}

async function sendVesselEmailUpdate(subscription) {
    if (!EMAIL_ENABLED || !mailTransporter) {
        throw new Error('Email service not configured')
    }

    const mmsi = subscription.mmsi
    let vessel = trackedVessels.get(mmsi) || vesselDatabase.find(v => v.mmsi === mmsi)
    if (!vessel) {
        vessel = { mmsi }
    }

    const refreshed = await refreshPositionForVessel(vessel, { force: true })
    const liveVessel = refreshed || vessel
    await ensurePortCoordinates(liveVessel)
    await ensureRoute(liveVessel)

    if (liveVessel.route && liveVessel.route.length >= 2 && liveVessel.latitude && liveVessel.longitude) {
        const etaCalc = estimateArrival(liveVessel.route, liveVessel.latitude, liveVessel.longitude, liveVessel.speed || 12)
        liveVessel.eta = etaCalc?.eta || liveVessel.eta
        liveVessel.distanceRemainingNm = etaCalc?.distanceRemaining || liveVessel.distanceRemainingNm || null
        liveVessel.hoursRemaining = etaCalc?.hoursRemaining || liveVessel.hoursRemaining || null
    }

    let weather = null
    if (liveVessel.latitude && liveVessel.longitude) {
        weather = await getMarineConditions(liveVessel.latitude, liveVessel.longitude)
        liveVessel.weather = weather
    }

    if (liveVessel.latitude && liveVessel.longitude) {
        liveVessel.bottleneckWarning = checkBottleneckProximity(liveVessel.latitude, liveVessel.longitude)
    }

    const etaLine = liveVessel.eta
        ? `ETA (Port of Discharge): ${new Date(liveVessel.eta).toUTCString()}`
        : 'ETA (Port of Discharge): unavailable'
    const warnings = buildWarningLines(liveVessel, weather)

    const subject = `Vessel Update: ${liveVessel.name || liveVessel.mmsi}`
    const bodyLines = [
        `Vessel: ${liveVessel.name || 'Unknown'} (${liveVessel.mmsi || 'N/A'})`,
        `Port of Loading: ${liveVessel.origin || 'N/A'}`,
        `Port of Discharge: ${liveVessel.destination || 'N/A'}`,
        formatPositionLine(liveVessel),
        etaLine,
        formatWeatherLine(weather)
    ]

    if (warnings.length) {
        bodyLines.push('', 'Warnings:', ...warnings.map(w => `- ${w}`))
    }

    const text = bodyLines.join('\n')

    await mailTransporter.sendMail({
        from: SMTP_FROM,
        to: subscription.email,
        subject,
        text
    })
}

async function runNotificationsTick() {
    if (!subscriptions.length) return
    const now = Date.now()

    for (const sub of subscriptions) {
        if (!sub.active) continue
        if (!sub.nextRun || sub.nextRun > now) continue
        try {
            await sendVesselEmailUpdate(sub)
            sub.lastSentAt = new Date().toISOString()
            sub.nextRun = Date.now() + sub.cadenceHours * 60 * 60 * 1000
        } catch (err) {
            sub.lastError = err.message
        }
    }
    saveSubscriptions()
}

function startNotificationsScheduler() {
    if (notificationsTimer) return
    loadSubscriptions()
    runNotificationsTick()
    notificationsTimer = setInterval(runNotificationsTick, 60000)
}

function getMyShipTrackingCachedUrl(mmsi, name) {
    if (mmsi && myShipTrackingUrlCache.has(mmsi.toString())) return myShipTrackingUrlCache.get(mmsi.toString())
    const nameKey = name ? normalizeName(name) : null
    if (nameKey && myShipTrackingUrlCache.has(nameKey)) return myShipTrackingUrlCache.get(nameKey)
    return null
}

function cacheMyShipTrackingUrl(mmsi, name, url) {
    if (!url) return
    if (mmsi) myShipTrackingUrlCache.set(mmsi.toString(), url)
    if (name) myShipTrackingUrlCache.set(normalizeName(name), url)
}

async function resolveMyShipTrackingInfo(mmsi, name) {
    const cachedUrl = getMyShipTrackingCachedUrl(mmsi, name)
    if (cachedUrl) return { url: cachedUrl, mmsi: mmsi ? mmsi.toString() : null, name }

    const term = mmsi || name
    if (!term) return null

    try {
        const searchUrl = `https://www.myshiptracking.com/vessels?name=${encodeURIComponent(term)}`
        const res = await fetch(searchUrl, {
            headers: { ...SCRAPE_HEADERS, 'Referer': 'https://www.myshiptracking.com/' }
        })
        if (!res.ok) return null
        const html = await res.text()

        let linkMatch = null
        if (mmsi) {
            const escaped = mmsi.toString().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            linkMatch = html.match(new RegExp(`href=\"(\\/vessels\\/[^\"\\s]*-mmsi-${escaped}-[^\"\\s]*)\"`, 'i'))
        }
        if (!linkMatch) {
            linkMatch = html.match(/href=\"(\/vessels\/[^\"\s]+)\"/i)
        }
        if (!linkMatch) return null

        const link = linkMatch[1]
        const url = `https://www.myshiptracking.com${link}`
        const mmsiMatch = link.match(/-mmsi-(\d{9})-/i)
        const nameMatch = link.match(/\/vessels\/([^\/]+?)-mmsi-\d{9}/i)
        const resolvedName = nameMatch ? nameMatch[1].replace(/-/g, ' ').toUpperCase() : name
        const resolvedMmsi = mmsiMatch ? mmsiMatch[1] : (mmsi ? mmsi.toString() : null)

        cacheMyShipTrackingUrl(resolvedMmsi, resolvedName, url)
        return { url, mmsi: resolvedMmsi, name: resolvedName }
    } catch (err) {
        console.error('MyShipTracking resolve failed:', err.message)
        return null
    }
}

function parseMyShipTrackingPosition(html) {
    if (!html) return null
    const match = html.match(/canvas_map_generate\("map_locator"\s*,\s*\d+\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)/i)
    if (!match) return null

    const latitude = Number(match[1])
    const longitude = Number(match[2])
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null

    const heading = Number(match[3])
    const speed = Number(match[4])
    return {
        latitude,
        longitude,
        heading: Number.isFinite(heading) ? heading : null,
        speed: Number.isFinite(speed) ? speed : null
    }
}

async function fetchMyShipTrackingPositionByMmsi(mmsi) {
    if (!mmsi) return null
    try {
        const url = `https://www.myshiptracking.com/requests/vesselonmap.php?type=json&mmsi=${encodeURIComponent(mmsi)}`
        const res = await fetch(url, {
            headers: { ...SCRAPE_HEADERS, 'Referer': 'https://www.myshiptracking.com/' }
        })
        if (!res.ok) return null
        const raw = (await res.text()).trim()
        if (!raw) return null
        const parts = raw.split(/\s+/)
        if (parts.length < 2) return null
        const latitude = Number(parts[0])
        const longitude = Number(parts[1])
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
        const speed = Number(parts[2])
        const heading = Number(parts[3])
        return {
            latitude,
            longitude,
            speed: Number.isFinite(speed) ? speed : null,
            heading: Number.isFinite(heading) && heading >= 0 && heading <= 360 ? heading : null
        }
    } catch (err) {
        console.error('MyShipTracking vesselonmap error:', err.message)
        return null
    }
}

function parseMyShipTrackingRouteList(xml) {
    if (!xml) return []
    const routes = []
    const blocks = xml.match(new RegExp('<P>[\\s\\S]*?<\\/P>', 'g')) || []
    blocks.forEach((block) => {
        const routeId = block.match(/<ROUTEID>([^<]+)<\/ROUTEID>/i)?.[1]?.trim()
        const name = block.match(/<NAME>([^<]+)<\/NAME>/i)?.[1]?.trim()
        if (routeId) {
            routes.push({ id: routeId, name })
        }
    })
    return routes
}

function parseMyShipTrackingRoutePoints(xml) {
    if (!xml) return []
    const points = []
    const blocks = xml.match(new RegExp('<P>[\\s\\S]*?<\\/P>', 'g')) || []
    blocks.forEach((block) => {
        const lat = Number(block.match(/<LAT>([^<]+)<\/LAT>/i)?.[1])
        const lon = Number(block.match(/<LON>([^<]+)<\/LON>/i)?.[1])
        const ord = Number(block.match(/<ORD>([^<]+)<\/ORD>/i)?.[1])
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
            points.push({ lat, lon, ord: Number.isFinite(ord) ? ord : points.length })
        }
    })
    return points.sort((a, b) => a.ord - b.ord)
}

async function fetchMyShipTrackingRoute(mmsi, originName, destName) {
    if (!mmsi) return null
    try {
        const portsUrl = `https://www.myshiptracking.com/requests/calc_ports.php?mmsi=${encodeURIComponent(mmsi)}`
        const portsRes = await fetch(portsUrl, {
            headers: { ...SCRAPE_HEADERS, 'Referer': 'https://www.myshiptracking.com/' }
        })
        if (!portsRes.ok) return null
        const portsXml = await portsRes.text()
        const routes = parseMyShipTrackingRouteList(portsXml)
        if (!routes.length) return null

        const routeId = routes[0].id
        const routeUrl = `https://www.myshiptracking.com/requests/calc_routes.php?route=${encodeURIComponent(routeId)}`
        const routeRes = await fetch(routeUrl, {
            headers: { ...SCRAPE_HEADERS, 'Referer': 'https://www.myshiptracking.com/' }
        })
        if (!routeRes.ok) return null
        const routeXml = await routeRes.text()
        const points = parseMyShipTrackingRoutePoints(routeXml)
        if (points.length < 2) return null

        return points.map((point, index) => ({
            lat: point.lat,
            lng: point.lon,
            name: index === 0 ? (originName || 'Origin') : index === points.length - 1 ? (destName || 'Destination') : `Waypoint ${index}`,
            type: index === 0 ? 'origin' : index === points.length - 1 ? 'destination' : 'waypoint'
        }))
    } catch (err) {
        console.error('MyShipTracking route fetch failed:', err.message)
        return null
    }
}

async function fetchMyShipTrackingPosition(vessel) {
    const mmsi = vessel?.mmsi ? vessel.mmsi.toString() : null
    const name = vessel?.name || null
    const quickPosition = mmsi ? await fetchMyShipTrackingPositionByMmsi(mmsi) : null
    if (quickPosition) {
        return {
            ...quickPosition,
            source: 'myshiptracking',
            updatedAt: new Date().toISOString(),
            myShipTrackingUrl: getMyShipTrackingCachedUrl(mmsi, name) || null
        }
    }

    let url = vessel?.myShipTrackingUrl || getMyShipTrackingCachedUrl(mmsi, name)
    if (!url) {
        const resolved = await resolveMyShipTrackingInfo(mmsi, name)
        url = resolved?.url || null
        if (resolved?.mmsi || resolved?.name) {
            cacheMyShipTrackingUrl(resolved?.mmsi || mmsi, resolved?.name || name, url)
        }
    }
    if (!url) return null

    try {
        const res = await fetch(url, {
            headers: { ...SCRAPE_HEADERS, 'Referer': 'https://www.myshiptracking.com/' }
        })
        if (!res.ok) return null
        const html = await res.text()
        const position = parseMyShipTrackingPosition(html)
        if (!position) return null
        return {
            ...position,
            source: 'myshiptracking',
            updatedAt: new Date().toISOString(),
            myShipTrackingUrl: url
        }
    } catch (err) {
        console.error('MyShipTracking position fetch failed:', err.message)
        return null
    }
}

async function refreshPositionForVessel(vessel, options = {}) {
    if (!vessel) return null
    const cacheKey = getPositionCacheKey(vessel.mmsi, vessel.name)
    if (!options.force) {
        const cached = getCachedPosition(cacheKey)
        if (cached) {
            const updated = { ...vessel }
            updated.latitude = cached.latitude
            updated.longitude = cached.longitude
            updated.speed = cached.speed ?? updated.speed
            updated.heading = cached.heading ?? updated.heading
            updated.positionSource = cached.source || updated.positionSource
            updated.updatedAt = cached.updatedAt || updated.updatedAt
            return updated
        }
    }

    const livePosition = await fetchMyShipTrackingPosition(vessel)
    if (!livePosition) return null

    const updated = { ...vessel }
    updated.latitude = livePosition.latitude
    updated.longitude = livePosition.longitude
    updated.speed = livePosition.speed ?? updated.speed
    updated.heading = livePosition.heading ?? updated.heading
    updated.positionSource = livePosition.source
    updated.updatedAt = livePosition.updatedAt
    updated.myShipTrackingUrl = livePosition.myShipTrackingUrl || updated.myShipTrackingUrl

    if (updated.latitude !== undefined && updated.longitude !== undefined) {
        updated.bottleneckWarning = checkBottleneckProximity(updated.latitude, updated.longitude)
    }

    await ensurePortCoordinates(updated)
    await ensureRoute(updated)

    if (updated.route && updated.route.length >= 2) {
        updated.nextWaypoint = updated.route[1] || null
        if (updated.latitude && updated.longitude) {
            const etaCalc = estimateArrival(updated.route, updated.latitude, updated.longitude, updated.speed || 12)
            updated.eta = etaCalc?.eta || updated.eta
            updated.distanceRemainingNm = etaCalc?.distanceRemaining || null
            updated.hoursRemaining = etaCalc?.hoursRemaining || null
        }
    }

    if (updated.mmsi) {
        trackedVessels.set(updated.mmsi.toString(), updated)
        const dbIdx = vesselDatabase.findIndex(v => v.mmsi === updated.mmsi)
        if (dbIdx >= 0) {
            vesselDatabase[dbIdx] = { ...vesselDatabase[dbIdx], ...updated }
        }
    }

    setCachedPosition(cacheKey, {
        latitude: updated.latitude,
        longitude: updated.longitude,
        speed: updated.speed,
        heading: updated.heading,
        source: updated.positionSource,
        updatedAt: updated.updatedAt
    })

    return updated
}

async function refreshTrackedPositions() {
    if (positionRefreshInFlight) return
    positionRefreshInFlight = true
    try {
        const combined = [...vesselDatabase, ...Array.from(trackedVessels.values())]
        const unique = Array.from(new Map(combined.map(v => [v.mmsi, v])).values())
        const list = unique.filter(v => v?.mmsi).slice(0, MAX_TRACKED_VESSELS)
        for (const vessel of list) {
            await refreshPositionForVessel(vessel)
        }
    } catch (err) {
        console.error('Position refresh error:', err.message)
    } finally {
        positionRefreshInFlight = false
    }
}

function startPositionRefresh() {
    if (positionRefreshTimer) return
    refreshTrackedPositions()
    positionRefreshTimer = setInterval(refreshTrackedPositions, POSITION_REFRESH_MS)
}

// ============================================
// AI-POWERED PDF EXTRACTION
// ============================================

const EXTRACTION_PROMPT = `You are a shipping document parser. This is a Bill of Lading document.
Extract vessel and shipping details from this document.

Return ONLY a valid JSON object with these fields (use null for missing values):
{
  "vessel": "vessel/ship name",
  "voyage": "voyage number",
  "portOfLoading": "port of loading (POL)",
  "portOfDischarge": "port of discharge (POD)",
  "finalDestination": "final place of delivery (if different from POD)",
  "eta": "estimated arrival date or shipped on board date",
  "blNumber": "bill of lading number",
  "shipper": "shipper/exporter name",
  "consignee": "consignee name",
  "mmsi": "9-digit MMSI number if visible"
}

Important rules:
- Prefer the exact POL and POD fields from the BL (not the final inland destination)
- Extract the actual port/city names, not labels
- Vessel name should be just the ship name without voyage number
- Return ONLY valid JSON, no markdown code blocks, no explanation`

async function extractWithGemini(pdfBuffer) {
    if (!genAI) return null

    try {
        const model = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' })
        const result = await model.generateContent({
            contents: [{
                role: 'user',
                parts: [
                    { inlineData: { mimeType: 'application/pdf', data: pdfBuffer.toString('base64') } },
                    { text: EXTRACTION_PROMPT }
                ]
            }],
            generationConfig: { temperature: 0, maxOutputTokens: 2000 }
        })

        const content = result.response.text() || '{}'
        const cleanContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
        const parsed = JSON.parse(cleanContent)
        console.log('Gemini 3 Flash extracted:', parsed)
        return parsed
    } catch (error) {
        console.error('Gemini extraction error:', error.message)
        return null
    }
}

async function extractWithOpenAIText(text) {
    if (!openai || !text || text.length < 50) return null

    let lastError = null
    for (const model of OPENAI_MODELS) {
        try {
            const response = await openai.responses.create({
                model,
                input: [
                    {
                        role: 'user',
                        content: [
                            { type: 'input_text', text: `${EXTRACTION_PROMPT}\n\nDocument text:\n${text.substring(0, 15000)}` }
                        ]
                    }
                ],
                max_output_tokens: 2000,
                temperature: 0
            })

            const content = response.output_text || '{}'
            const cleanContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
            const parsed = JSON.parse(cleanContent)
            console.log(`${model} extracted:`, parsed)
            return parsed
        } catch (error) {
            lastError = error
            console.error(`OpenAI text extraction error (${model}):`, error.message)
        }
    }

    if (lastError) return null
    return null
}

async function extractWithOpenAIPDF(pdfBuffer) {
    if (!openai) return null

    let file = null
    try {
        const fs = require('fs')
        const os = require('os')
        const crypto = require('crypto')

        const tempDir = os.tmpdir()
        const tempId = crypto.randomBytes(8).toString('hex')
        const tempPdfPath = path.join(tempDir, `bl_${tempId}.pdf`)

        // Write PDF buffer to temp file
        fs.writeFileSync(tempPdfPath, pdfBuffer)

        console.log('Uploading PDF to OpenAI...')

        // Upload file to OpenAI
        file = await openai.files.create({
            file: fs.createReadStream(tempPdfPath),
            purpose: 'assistants'
        })

        console.log('PDF uploaded, file ID:', file.id)

        // Clean up temp file
        try { fs.unlinkSync(tempPdfPath) } catch (e) { /* ignore */ }

        let lastError = null
        for (const model of OPENAI_MODELS) {
            try {
                console.log(`Calling ${model} with PDF file...`)
                const response = await openai.responses.create({
                    model,
                    input: [
                        {
                            role: 'user',
                            content: [
                                {
                                    type: 'input_file',
                                    file_id: file.id
                                },
                                {
                                    type: 'input_text',
                                    text: EXTRACTION_PROMPT
                                }
                            ]
                        }
                    ],
                    max_output_tokens: 2000,
                    temperature: 0
                })

                const content = response.output_text || '{}'
                const cleanContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
                const parsed = JSON.parse(cleanContent)
                console.log(`${model} PDF extracted:`, parsed)
                return parsed
            } catch (error) {
                lastError = error
                console.error(`OpenAI PDF extraction error (${model}):`, error.message)
            }
        }

        if (lastError) return null
        return null
    } catch (error) {
        console.error('OpenAI PDF extraction error:', error.message)
        return null
    } finally {
        if (openai && file?.id) {
            try {
                await openai.files.del(file.id)
                console.log('Deleted uploaded file:', file.id)
            } catch (e) { /* ignore deletion errors */ }
        }
    }
}

async function extractVesselDetailsFromPDFImage(pdfBuffer, extractedText = '') {
    // Try Gemini 3 Flash first (supports PDF directly)
    let result = await extractWithGemini(pdfBuffer)
    if (result && result.vessel) {
        return result
    }

    // Fallback to OpenAI with PDF file upload
    console.log('Gemini failed, trying OpenAI PDF fallback...')
    result = await extractWithOpenAIPDF(pdfBuffer)
    if (result && result.vessel) {
        return result
    }

    // Last resort: try OpenAI with extracted text (if any)
    if (extractedText && extractedText.length > 50) {
        console.log('OpenAI PDF failed, trying with text...')
        result = await extractWithOpenAIText(extractedText)
        if (result && result.vessel) {
            return result
        }
    }

    return null
}

async function extractVesselDetailsWithAI(text) {
    if (!text || text.trim().length < 50) {
        return {
            vessel: null,
            voyage: null,
            portOfLoading: null,
            portOfDischarge: null,
            finalDestination: null,
            eta: null,
            blNumber: null
        }
    }

    // Try Gemini first
    if (genAI) {
        try {
            const model = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' })
            const result = await model.generateContent({
                contents: [{ role: 'user', parts: [{ text: `${EXTRACTION_PROMPT}\n\nDocument text:\n${text.substring(0, 15000)}` }] }],
                generationConfig: { temperature: 0, maxOutputTokens: 2000 }
            })

            const content = result.response.text() || '{}'
            const cleanContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
            const parsed = JSON.parse(cleanContent)
            if (parsed && parsed.vessel) {
                console.log('Gemini 3 Flash extracted:', parsed)
                return parsed
            }
        } catch (error) {
            console.error('Gemini text extraction error:', error.message)
        }
    }

    // Fallback to OpenAI
    console.log('Gemini failed, trying OpenAI for text extraction...')
    const gptResult = await extractWithOpenAIText(text)
    if (gptResult && gptResult.vessel) {
        return gptResult
    }

    return {
        vessel: null,
        voyage: null,
        portOfLoading: null,
        portOfDischarge: null,
        finalDestination: null,
        eta: null,
        blNumber: null
    }
}

// Port geocoding via Nominatim OpenStreetMap
const geocodeCache = new Map()

// Generate simplified search terms from a port name
function simplifyPortName(portName) {
    const variants = []
    const clean = portName.trim()

    // Original
    variants.push(clean)

    // Remove common suffixes
    const noSuffix = clean
        .replace(/,?\s*(UNITED STATES|USA|US|UK|CHINA|INDIA|UAE)$/i, '')
        .replace(/,?\s*(PORT|TERMINAL|HARBOR|HARBOUR|SEAPORT)$/i, '')
        .trim()
    if (noSuffix !== clean) variants.push(noSuffix)

    // Extract parts after comma (often the country/region)
    const parts = clean.split(',').map(p => p.trim())
    if (parts.length > 1) {
        // Try "city, country" format
        variants.push(`${parts[0]}, ${parts[parts.length - 1]}`)
        // Try just the first part (port/city name)
        variants.push(parts[0])
        // Try just the country
        variants.push(parts[parts.length - 1])
    }

    // Remove "PORT" prefix
    const noPrefix = clean.replace(/^(PORT\s+OF\s+|PORT\s+)/i, '').trim()
    if (noPrefix !== clean) variants.push(noPrefix)

    // For compound names, try first word + country
    const words = parts[0].split(/\s+/)
    if (words.length > 1 && parts.length > 1) {
        variants.push(`${words[0]} ${parts[parts.length - 1]}`)
    }

    return [...new Set(variants)] // Remove duplicates
}

// Geocode API key for geocode.maps.co (from environment variable)
const GEOCODE_API_KEY = process.env.GEOCODE_API_KEY

async function geocodePort(portName) {
    if (!portName) return null
    const cacheKey = portName.trim().toLowerCase()
    if (geocodeCache.has(cacheKey)) return geocodeCache.get(cacheKey)

    const variants = simplifyPortName(portName)
    console.log('Geocoding port:', portName, '- trying variants:', variants.slice(0, 3).join(', '))

    // geocode.maps.co - primary (with API key)
    if (GEOCODE_API_KEY) {
        for (const searchTerm of variants.slice(0, 3)) {
            try {
                const url = `https://geocode.maps.co/search?q=${encodeURIComponent(searchTerm)}&api_key=${GEOCODE_API_KEY}&limit=1`
                const res = await fetch(url, {
                    headers: { 'Accept': 'application/json' }
                })

                if (res.ok) {
                    const data = await res.json()
                    if (Array.isArray(data) && data[0]) {
                        const coords = { lat: Number(data[0].lat), lon: Number(data[0].lon) }
                        console.log('Geocoded (maps.co)', searchTerm, '->', coords.lat.toFixed(4), coords.lon.toFixed(4))
                        geocodeCache.set(cacheKey, coords)
                        return coords
                    }
                }
            } catch (err) {
                console.error('maps.co geocode error for', searchTerm, ':', err.message)
            }
            // Rate limit - 1 request per second for free tier
            await new Promise(r => setTimeout(r, 1000))
        }
    }

    // Open-Meteo geocoding fallback (no API key)
    for (const searchTerm of variants.slice(0, 4)) {
        try {
            const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(searchTerm)}&count=1&language=en&format=json`
            const res = await fetch(url, {
                headers: { 'Accept': 'application/json' }
            })
            if (res.ok) {
                const data = await res.json()
                const first = data?.results?.[0]
                if (first && Number.isFinite(first.latitude) && Number.isFinite(first.longitude)) {
                    const coords = { lat: Number(first.latitude), lon: Number(first.longitude) }
                    console.log('Geocoded (open-meteo)', searchTerm, '->', coords.lat.toFixed(4), coords.lon.toFixed(4))
                    geocodeCache.set(cacheKey, coords)
                    return coords
                }
            }
        } catch (err) {
            console.error('open-meteo geocode error for', searchTerm, ':', err.message)
        }
        await new Promise(r => setTimeout(r, 400))
    }

    // Nominatim fallback
    for (const searchTerm of variants) {
        const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(searchTerm)}`
        try {
            await new Promise(r => setTimeout(r, 1100)) // Rate limit

            const res = await fetch(url, {
                headers: {
                    'User-Agent': 'ShippingTracker/1.0 (https://github.com/shipping-tracker)',
                    'Accept': 'application/json',
                    'Accept-Language': 'en'
                }
            })

            if (res.status === 403 || res.status === 503 || res.status === 429) {
                continue
            }

            if (!res.ok) continue

            const data = await res.json()
            const first = data && data[0]
            if (first) {
                const coords = { lat: Number(first.lat), lon: Number(first.lon) }
                console.log('Geocoded (Nominatim)', searchTerm, '->', coords.lat.toFixed(4), coords.lon.toFixed(4))
                geocodeCache.set(cacheKey, coords)
                return coords
            }
        } catch (err) {
            // Silently continue to next variant
        }
    }

    console.error('All geocode attempts failed for:', portName)
    return null
}

async function ensurePortCoordinates(vessel) {
    if (!vessel) return vessel
    const setOrigin = async () => {
        if (vessel.origin && (!vessel.originLat || !vessel.originLng)) {
            const o = await geocodePort(vessel.origin)
            if (o) {
                vessel.originLat = o.lat
                vessel.originLng = o.lon
            }
        }
    }

    const setDest = async () => {
        if (vessel.destination && (!vessel.destLat || !vessel.destLng)) {
            const d = await geocodePort(vessel.destination)
            if (d) {
                vessel.destLat = d.lat
                vessel.destLng = d.lon
            }
        }
    }

    await Promise.all([setOrigin(), setDest()])

    return vessel
}

async function ensureRoute(vessel) {
    if (!vessel) return vessel
    const hasCoords = vessel.originLat && vessel.originLng && vessel.destLat && vessel.destLng
    const hasRoute = Array.isArray(vessel.route) && vessel.route.length >= 2

    if (vessel.mmsi && (!hasRoute || vessel.routeSource === 'searoute')) {
        const scrapedRoute = await fetchMyShipTrackingRoute(vessel.mmsi, vessel.origin, vessel.destination)
        if (scrapedRoute && scrapedRoute.length >= 2) {
            vessel.route = scrapedRoute
            vessel.routeSource = 'myshiptracking'
        }
    }

    if (hasCoords && (!hasRoute || vessel.routeSource !== 'myshiptracking')) {
        vessel.route = calculateRoute(
            vessel.originLat,
            vessel.originLng,
            vessel.destLat,
            vessel.destLng,
            vessel.origin,
            vessel.destination
        )
        vessel.routeSource = vessel.routeSource || 'searoute'
    }

    return vessel
}

// Fetch marine conditions (Open-Meteo free API)
async function getMarineConditions(lat, lon) {
    if (!lat || !lon) return null
    const url = `https://marine-api.open-meteo.com/v1/marine?latitude=${lat}&longitude=${lon}&current=wave_height,wave_direction,wind_speed_10m,wind_direction_10m&timezone=UTC`
    try {
        const res = await fetch(url)
        if (!res.ok) throw new Error(`marine ${res.status}`)
        const data = await res.json()
        return data.current || null
    } catch (err) {
        console.error('Marine conditions error', err.message)
        return null
    }
}

// Get vessel status from VesselFinder click API
// Note: Free tier doesn't include coordinates, but gives speed/course/destination
async function getVesselStatus(mmsi) {
    if (!mmsi) return null
    try {
        const url = `https://www.vesselfinder.com/api/pub/click/${mmsi}`
        const res = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/json',
                'Referer': 'https://www.vesselfinder.com/'
            }
        })
        if (!res.ok) return null
        const data = await res.json()

        // VesselFinder click API returns:
        // ss = speed, cu = course, dest = destination, ts = timestamp
        // name, imo, country, type, gt (gross tonnage), etc.
        const status = {
            name: data.name || null,
            speed: data.ss ?? null,
            heading: data.cu ?? null,
            currentDestination: data.dest || null,
            vesselType: data.type || null,
            country: data.country || null,
            imo: data.imo || null,
            grossTonnage: data.gt || null,
            eta: data.etaTS ? new Date(data.etaTS * 1000).toISOString() : null,
            lastUpdate: data.ts ? new Date(data.ts * 1000).toISOString() : null,
            source: 'vesselfinder-api'
        }

        console.log('VesselFinder status for', mmsi, ':', status.speed, 'kn, dest:', status.currentDestination)
        return status
    } catch (err) {
        console.error('VesselFinder status fetch failed:', err.message)
        return null
    }
}

// Attempt to get live position from cached scraper updates
function getLivePosition(mmsi) {
    const tracked = trackedVessels.get(mmsi?.toString())
    if (tracked && tracked.latitude && tracked.longitude) {
        return {
            latitude: tracked.latitude,
            longitude: tracked.longitude,
            speed: tracked.speed,
            heading: tracked.heading || tracked.cog,
            source: tracked.positionSource || 'myshiptracking',
            updatedAt: tracked.updatedAt
        }
    }
    return null
}

function extractMmsiFromText(text) {
    if (!text) return null
    const match = text.toString().match(/\b(\d{9})\b/)
    return match ? match[1] : null
}

function normalizeName(name) {
    return (name || '').toString().toUpperCase().replace(/[^A-Z0-9]/g, '')
}

// Search for vessel MMSI by name - efficient scraping only (no API keys needed)
async function searchVesselByName(vesselName) {
    if (!vesselName) return null

    const cleanName = vesselName.trim().toUpperCase()
    console.log('Searching for vessel MMSI:', cleanName)

    // VesselFinder scraping - most reliable
    async function vesselFinderScrape(term) {
        try {
            // Step 1: Search page
            const searchUrl = `https://www.vesselfinder.com/vessels?name=${encodeURIComponent(term)}`
            const res = await fetch(searchUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'text/html' }
            })
            if (!res.ok) return null
            const html = await res.text()

            // Find vessel detail link
            const detailMatch = html.match(/href="(\/vessels\/details\/\d+[^"]*)"/i) ||
                html.match(/href="(\/vessels\/[^"\s]+IMO-\d+[^"]*)"/i)
            if (!detailMatch) return null

            // Step 2: Get MMSI from detail page
            const detailUrl = 'https://www.vesselfinder.com' + detailMatch[1]
            const detailRes = await fetch(detailUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'text/html' }
            })
            if (!detailRes.ok) return null
            const detailHtml = await detailRes.text()

            // Extract MMSI with multiple patterns
            const mmsiMatch = detailHtml.match(/MMSI<\/td>\s*<td[^>]*>(\d{9})/i) ||
                detailHtml.match(/"mmsi"\s*:\s*"?(\d{9})/i) ||
                detailHtml.match(/MMSI:\s*(\d{9})/i)
            if (!mmsiMatch) return null

            // Extract vessel name
            const nameMatch = detailHtml.match(/<h1[^>]*>([^<]+)<\/h1>/i)
            console.log('Found vessel via VesselFinder:', nameMatch?.[1]?.trim() || term, mmsiMatch[1])
            return { mmsi: mmsiMatch[1], name: (nameMatch?.[1] || term).trim(), source: 'vesselfinder' }
        } catch (err) {
            console.log('VesselFinder failed:', err.message)
            return null
        }
    }

    // Generate name variations: with spaces, without spaces, first word, hyphenated
    function generateNameVariants(name) {
        const variants = new Set()
        const upper = name.toUpperCase().trim()

        // Original with spaces
        variants.add(upper)

        // Without any spaces (SOLUNITY)
        variants.add(upper.replace(/\s+/g, ''))

        // With single space between words
        variants.add(upper.replace(/\s+/g, ' '))

        // First word only (SOL)
        const firstWord = upper.split(/\s+/)[0]
        if (firstWord.length >= 3) variants.add(firstWord)

        // With hyphens instead of spaces (SOL-UNITY)
        variants.add(upper.replace(/\s+/g, '-'))

        // Try adding space after common prefixes if name has no spaces
        if (!upper.includes(' ') && upper.length > 4) {
            // Try splitting at common word boundaries
            for (let i = 3; i < Math.min(upper.length - 2, 8); i++) {
                variants.add(upper.slice(0, i) + ' ' + upper.slice(i))
            }
        }

        return Array.from(variants)
    }

    const searchVariants = generateNameVariants(cleanName)
    console.log('Trying name variants:', searchVariants.slice(0, 5).join(', '))

    for (const term of searchVariants) {
        const result = await vesselFinderScrape(term)
        if (result) return result
    }

    // Fallback: Try MyShipTracking autocomplete with variations (fast, returns MMSI in response)
    for (const term of searchVariants.slice(0, 3)) {
        try {
            const url = `https://www.myshiptracking.com/requests/autocomplete-ede42.php?term=${encodeURIComponent(term)}`
            const res = await fetch(url, {
                headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://www.myshiptracking.com/' }
            })
            if (res.ok) {
                const data = await res.json()
                if (Array.isArray(data) && data.length > 0) {
                    const match = data[0]
                    const mmsiMatch = (match.value || match.label || '').match(/\b(\d{9})\b/)
                    if (mmsiMatch) {
                        console.log('Found vessel via MyShipTracking:', match.label, mmsiMatch[1])
                        return { mmsi: mmsiMatch[1], name: (match.label || '').split(' - ')[0].trim(), source: 'myshiptracking' }
                    }
                }
            }
        } catch (err) {
            console.log('MyShipTracking failed:', err.message)
        }
    }

    // Fallback: MyShipTracking search page (parses vessel link)
    for (const term of searchVariants.slice(0, 3)) {
        const resolved = await resolveMyShipTrackingInfo(null, term)
        if (resolved?.mmsi) {
            console.log('Found vessel via MyShipTracking search:', resolved.name || term, resolved.mmsi)
            return {
                mmsi: resolved.mmsi,
                name: resolved.name || term,
                source: 'myshiptracking',
                myShipTrackingUrl: resolved.url
            }
        }
    }

    console.log('Could not find MMSI for vessel:', cleanName)
    return null
}

async function createVesselFromImport(details, rawText = '') {
    if (!details.vessel) return null

    const vesselName = (details.vessel || '').toUpperCase().trim()
    const portOfLoading = details.portOfLoading || details.origin || null
    const portOfDischarge = details.portOfDischarge || details.destination || null
    const finalDestination = details.finalDestination || null

    // Try to extract MMSI from document or AI extraction
    let mmsi = details.mmsi || extractMmsiFromText(rawText)
    let vesselInfo = null

    // If no MMSI found, search vessel databases
    if (!mmsi) {
        console.log('No MMSI in document, searching vessel databases...')
        vesselInfo = await searchVesselByName(vesselName)
        if (vesselInfo && vesselInfo.mmsi) {
            mmsi = vesselInfo.mmsi
            console.log('Found MMSI from database:', mmsi)
        }
    }

    // If still no MMSI, we cannot track this vessel with live sources
    if (!mmsi) {
        console.warn('No MMSI found; cannot start live tracking:', vesselName)
        return null
    }

    // Get coordinates for origin and destination ports + vessel status from VesselFinder
    const [originCoords, destCoords, vesselStatus] = await Promise.all([
        geocodePort(portOfLoading),
        geocodePort(portOfDischarge),
        getVesselStatus(mmsi)
    ])
    console.log('Geocode results:', { origin: portOfLoading, originCoords, destination: portOfDischarge, destCoords })
    console.log('Vessel status from VesselFinder:', vesselStatus)

    // Check if we have cached position from previous scraper refresh
    const cachedPosition = getLivePosition(mmsi)

    const vessel = {
        mmsi: mmsi.toString(),
        name: vesselInfo?.name || vesselName,
        imo: vesselStatus?.imo || vesselInfo?.imo || null,
        flag: vesselStatus?.country || vesselInfo?.flag || null,
        shipType: vesselStatus?.vesselType || vesselInfo?.type || null,
        destination: portOfDischarge || null,
        currentDestination: vesselStatus?.currentDestination || null, // Current reported destination
        origin: portOfLoading || null,
        voyage: details.voyage || null,
        voyageNo: details.voyage || null,
        blNumber: details.blNumber || null,
        shipper: details.shipper || null,
        consignee: details.consignee || null,
        finalDestination: finalDestination,
        originLat: originCoords?.lat ?? null,
        originLng: originCoords?.lon ?? null,
        destLat: destCoords?.lat ?? null,
        destLng: destCoords?.lon ?? null,
        // Live position from scraper cache (VesselFinder API doesn't provide coords)
        latitude: cachedPosition?.latitude ?? null,
        longitude: cachedPosition?.longitude ?? null,
        speed: vesselStatus?.speed ?? cachedPosition?.speed ?? null,
        heading: vesselStatus?.heading ?? cachedPosition?.heading ?? null,
        positionSource: cachedPosition?.source ?? null,
        grossTonnage: vesselStatus?.grossTonnage || null,
        myShipTrackingUrl: vesselInfo?.myShipTrackingUrl || null,
        importedAt: new Date().toISOString(),
        updatedAt: cachedPosition?.updatedAt || vesselStatus?.lastUpdate || new Date().toISOString()
    }

    // Ensure coords + route
    await ensurePortCoordinates(vessel)
    await ensureRoute(vessel)

    if (vessel.route && vessel.route.length >= 2) {
        vessel.nextWaypoint = vessel.route[1] || null
        console.log('Route calculated:', vessel.route.length, 'waypoints')

        if (vessel.latitude && vessel.longitude) {
            const etaCalc = estimateArrival(vessel.route, vessel.latitude, vessel.longitude, vessel.speed || 12)
            vessel.eta = etaCalc?.eta || details.eta || vesselStatus?.eta || null
            vessel.distanceRemainingNm = etaCalc?.distanceRemaining || null
            vessel.hoursRemaining = etaCalc?.hoursRemaining || null
        } else {
            vessel.eta = details.eta || null
        }
    } else {
        console.log('Route NOT calculated - missing coords:', { originLat: vessel.originLat, originLng: vessel.originLng, destLat: vessel.destLat, destLng: vessel.destLng })
    }

    trackedVessels.set(vessel.mmsi, vessel)
    const refreshed = await refreshPositionForVessel(vessel, { force: true })
    return refreshed || vessel
}

// ============================================
// API ENDPOINTS
// ============================================

// Test endpoint to add a vessel manually (for testing when Gemini API is rate-limited)
app.post('/api/test/add-vessel', async (req, res) => {
    const { mmsi, name, origin, destination, voyage, blNumber } = req.body
    if (!mmsi || !name) {
        return res.status(400).json({ error: 'mmsi and name required' })
    }

    const vessel = {
        mmsi: mmsi.toString(),
        name,
        origin,
        destination,
        voyage,
        blNumber,
        importedAt: new Date().toISOString()
    }

    // Add to database
    const idx = vesselDatabase.findIndex(v => v.mmsi === vessel.mmsi)
    if (idx >= 0) {
        vesselDatabase[idx] = { ...vesselDatabase[idx], ...vessel }
    } else {
        vesselDatabase.push(vessel)
    }

    const refreshed = await refreshPositionForVessel(vessel, { force: true })
    console.log('Test vessel added:', name, mmsi)
    res.json({ success: true, vessel: refreshed || vessel })
})

app.post('/api/import/bl', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' })

    try {
        const dataBuffer = req.file.buffer
        let details = { vessel: null }
        let text = ''
        let extractionMethod = 'none'
        let isScannedPDF = false

        console.log(`Processing PDF: ${req.file.originalname}, size: ${dataBuffer.length} bytes`)

        // Step 1: Extract text from PDF
        try {
            const pdfData = await pdfParse(dataBuffer)
            text = pdfData.text || ''
            const cleanedText = text.replace(/\s+/g, '').trim()
            isScannedPDF = cleanedText.length < 50

            if (isScannedPDF) {
                console.log('PDF appears to be scanned')
            } else {
                console.log(`Extracted ${text.length} characters from PDF`)
            }
        } catch (e) {
            console.error('pdf-parse error:', e.message)
        }

        // Step 2: Use AI to extract structured data (Gemini 3 Flash with OpenAI fallback)
        if (process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY) {
            if (!isScannedPDF && text.length > 50) {
                console.log('Using AI text extraction...')
                details = await extractVesselDetailsWithAI(text)
                extractionMethod = 'ai-text'
            } else {
                console.log('Using AI vision extraction...')
                const visionDetails = await extractVesselDetailsFromPDFImage(dataBuffer, text)
                if (visionDetails && visionDetails.vessel) {
                    details = visionDetails
                    extractionMethod = 'ai-vision'
                    isScannedPDF = false
                }
            }
        }

        // Create vessel from extracted details
        const vessel = await createVesselFromImport(details, text)

        if (vessel) {
            const idx = vesselDatabase.findIndex(v => v.mmsi === vessel.mmsi)
            if (idx >= 0) {
                vesselDatabase[idx] = { ...vesselDatabase[idx], ...vessel }
            } else {
                vesselDatabase.push(vessel)
            }
            console.log('Vessel imported:', vessel.name, vessel.mmsi)
        }

        const response = {
            success: !!vessel,
            vessel,
            extractedDetails: details,
            extractionMethod,
            textLength: text.length
        }

        // Add error message if vessel couldn't be created
        if (!vessel && details.vessel) {
            response.error = `Could not find MMSI for vessel "${details.vessel}". The vessel may not be in global vessel databases. Try adding the 9-digit MMSI number to the Bill of Lading.`
        } else if (!vessel) {
            response.error = 'Could not extract vessel information from the PDF.'
        }

        res.json(response)
    } catch (error) {
        console.error('Import error:', error)
        res.status(500).json({ error: error.message })
    }
})

app.get('/api/vessels/search', async (req, res) => {
    const query = (req.query.q || '').toString().trim()
    if (!query) return res.json({ vessels: [] })

    const candidates = [...trackedVessels.values(), ...vesselDatabase]
    const matches = candidates.filter(v =>
        (v.name || '').toLowerCase().includes(query.toLowerCase()) ||
        (v.mmsi || '').toString().includes(query)
    )
    const unique = Array.from(new Map(matches.map(v => [v.mmsi, v])).values())
    if (unique.length > 0) {
        return res.json({ vessels: unique.slice(0, MAX_TRACKED_VESSELS) })
    }

    let found = null
    if (/^\\d{9}$/.test(query)) {
        found = { mmsi: query, name: null, source: 'mmsi' }
    } else {
        found = await searchVesselByName(query)
    }

    if (!found?.mmsi) {
        return res.json({ vessels: [] })
    }

    let vessel = trackedVessels.get(found.mmsi) || vesselDatabase.find(v => v.mmsi === found.mmsi)
    if (!vessel) {
        const vesselStatus = await getVesselStatus(found.mmsi)
        vessel = {
            mmsi: found.mmsi.toString(),
            name: found.name || vesselStatus?.name || query.toUpperCase(),
            imo: vesselStatus?.imo || null,
            flag: vesselStatus?.country || null,
            shipType: vesselStatus?.vesselType || null,
            currentDestination: vesselStatus?.currentDestination || null,
            searchSource: found.source || 'external',
            importedAt: new Date().toISOString(),
            updatedAt: vesselStatus?.lastUpdate || new Date().toISOString()
        }
    }

    const refreshed = await refreshPositionForVessel(vessel, { force: true })
    const finalVessel = refreshed || vessel

    trackedVessels.set(finalVessel.mmsi, finalVessel)
    const idx = vesselDatabase.findIndex(v => v.mmsi === finalVessel.mmsi)
    if (idx >= 0) {
        vesselDatabase[idx] = { ...vesselDatabase[idx], ...finalVessel }
    } else {
        vesselDatabase.push(finalVessel)
    }

    res.json({ vessels: [finalVessel] })
})

app.get('/api/vessels', async (req, res) => {
    const vessels = Array.from(trackedVessels.values())
    const allVessels = [...vesselDatabase.map(v => ({
        ...v,
        bottleneckWarning: v.latitude && v.longitude ? checkBottleneckProximity(v.latitude, v.longitude) : null
    })), ...vessels]
    const uniqueVessels = Array.from(new Map(allVessels.map(v => [v.mmsi, v])).values())
    const sorted = uniqueVessels.sort((a, b) => {
        const ta = new Date(a.updatedAt || a.importedAt || 0).getTime()
        const tb = new Date(b.updatedAt || b.importedAt || 0).getTime()
        return tb - ta
    })
    res.json({ vessels: sorted.slice(0, MAX_TRACKED_VESSELS) })
})

app.get('/api/bottlenecks', (req, res) => {
    res.json({ bottlenecks: getBottlenecks() })
})

app.get('/api/vessels/:mmsi/details', async (req, res) => {
    const mmsi = req.params.mmsi?.toString()
    if (!mmsi) return res.status(400).json({ error: 'mmsi required' })

    const vessel = trackedVessels.get(mmsi) || vesselDatabase.find(v => v.mmsi === mmsi)
    if (!vessel) return res.status(404).json({ error: 'not found' })

    const enriched = { ...vessel }

    // Always refresh vessel status from VesselFinder API (speed, heading, current destination)
    if (mmsi.match(/^\d{9}$/)) {
        const vesselStatus = await getVesselStatus(mmsi)
        if (vesselStatus) {
            enriched.speed = vesselStatus.speed ?? enriched.speed
            enriched.heading = vesselStatus.heading ?? enriched.heading
            enriched.currentDestination = vesselStatus.currentDestination || enriched.currentDestination
            enriched.vesselType = vesselStatus.vesselType || enriched.shipType
            enriched.imo = vesselStatus.imo || enriched.imo
            enriched.grossTonnage = vesselStatus.grossTonnage || enriched.grossTonnage
            enriched.eta = enriched.eta || vesselStatus.eta
            enriched.statusSource = 'vesselfinder-api'
            enriched.statusUpdatedAt = vesselStatus.lastUpdate

            // Note: VesselFinder free tier doesn't provide coordinates
            // Coordinates come from MyShipTracking scraper
            const cachedPosition = getLivePosition(mmsi)
            if (cachedPosition) {
                enriched.latitude = cachedPosition.latitude
                enriched.longitude = cachedPosition.longitude
                enriched.positionSource = cachedPosition.source
                enriched.updatedAt = cachedPosition.updatedAt
            }

            // Update stored vessel data
            trackedVessels.set(mmsi, { ...trackedVessels.get(mmsi), ...enriched })
            const dbIdx = vesselDatabase.findIndex(v => v.mmsi === mmsi)
            if (dbIdx >= 0) vesselDatabase[dbIdx] = { ...vesselDatabase[dbIdx], ...enriched }
        }
    }

    const refreshed = await refreshPositionForVessel(enriched, { force: true })
    if (refreshed) {
        Object.assign(enriched, refreshed)
    }

    if (enriched.latitude && enriched.longitude) {
        enriched.weather = await getMarineConditions(enriched.latitude, enriched.longitude)
    }

    await ensurePortCoordinates(enriched)
    await ensureRoute(enriched)

    if (enriched.route && enriched.route.length >= 2) {
        enriched.nextWaypoint = enriched.route[1] || null
        if (enriched.latitude && enriched.longitude) {
            const etaCalc = estimateArrival(enriched.route, enriched.latitude, enriched.longitude, enriched.speed || 12)
            enriched.eta = etaCalc?.eta || enriched.eta
            enriched.distanceRemainingNm = etaCalc?.distanceRemaining || null
            enriched.hoursRemaining = etaCalc?.hoursRemaining || null
        }
    }

    res.json({ vessel: enriched })
})

app.get('/api/notifications', (req, res) => {
    const mmsi = req.query.mmsi?.toString()
    const email = req.query.email?.toString()
    let list = subscriptions
    if (mmsi) {
        list = list.filter(s => s.mmsi === mmsi)
    }
    if (email) {
        list = list.filter(s => s.email === email)
    }
    res.json({ subscriptions: list })
})

app.post('/api/notifications', async (req, res) => {
    if (!EMAIL_ENABLED) {
        return res.status(400).json({ error: 'Email service not configured' })
    }
    const { mmsi, email, cadenceHours } = req.body || {}
    if (!mmsi || !email) {
        return res.status(400).json({ error: 'mmsi and email required' })
    }
    const cadence = normalizeCadenceHours(cadenceHours || 24)
    const id = `sub_${Date.now()}_${Math.floor(Math.random() * 1000)}`
    const entry = {
        id,
        mmsi: mmsi.toString(),
        email: email.toString().trim().toLowerCase(),
        cadenceHours: cadence,
        active: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        nextRun: Date.now() + cadence * 60 * 60 * 1000
    }
    subscriptions.push(entry)
    saveSubscriptions()
    res.json({ subscription: entry })
})

app.post('/api/notifications/:id/cancel', (req, res) => {
    const id = req.params.id?.toString()
    const sub = subscriptions.find(s => s.id === id)
    if (!sub) return res.status(404).json({ error: 'not found' })
    sub.active = false
    sub.updatedAt = new Date().toISOString()
    saveSubscriptions()
    res.json({ subscription: sub })
})

app.post('/api/notifications/:id/test', async (req, res) => {
    if (!EMAIL_ENABLED) {
        return res.status(400).json({ error: 'Email service not configured' })
    }
    const id = req.params.id?.toString()
    const sub = subscriptions.find(s => s.id === id)
    if (!sub) return res.status(404).json({ error: 'not found' })
    try {
        await sendVesselEmailUpdate(sub)
        sub.lastSentAt = new Date().toISOString()
        sub.nextRun = Date.now() + sub.cadenceHours * 60 * 60 * 1000
        sub.updatedAt = new Date().toISOString()
        saveSubscriptions()
        res.json({ ok: true, subscription: sub })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

app.get('/api/health', (req, res) => res.json({
    status: 'ok',
    timestamp: new Date(),
    trackedVessels: trackedVessels.size,
    positionRefreshMs: POSITION_REFRESH_MS
}))

// Serve static files
if (process.env.NODE_ENV === 'production') {
    console.log('Production mode: serving from dist/')
    app.use(express.static(path.join(__dirname, 'dist')))
    app.get(/.*/, (req, res, next) => {
        if (req.path.startsWith('/api') || req.path.startsWith('/ws')) return next()
        res.sendFile(path.join(__dirname, 'dist', 'index.html'))
    })
}

const server = http.createServer(app)
const wss = new WebSocketServer({ server })

wss.on('connection', (ws) => {
    console.log('Client connected to WebSocket')
    const interval = setInterval(() => {
        const combined = [...vesselDatabase, ...Array.from(trackedVessels.values())]
        const unique = Array.from(new Map(combined.map(v => [v.mmsi, v])).values())
        const sorted = unique.sort((a, b) => {
            const ta = new Date(a.updatedAt || a.importedAt || 0).getTime()
            const tb = new Date(b.updatedAt || b.importedAt || 0).getTime()
            return tb - ta
        })
        ws.send(JSON.stringify({ type: 'vessels', data: sorted.slice(0, MAX_TRACKED_VESSELS) }))
    }, POSITION_REFRESH_MS)
    ws.on('close', () => clearInterval(interval))
})

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`)
    console.log(`Gemini API Key configured: ${!!process.env.GEMINI_API_KEY}`)
    console.log(`Position refresh interval: ${POSITION_REFRESH_MS}ms`)
    console.log(`Email notifications enabled: ${EMAIL_ENABLED}`)
    startPositionRefresh()
    startNotificationsScheduler()
})

module.exports = app
