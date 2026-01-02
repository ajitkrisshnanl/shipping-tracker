/**
 * Backend Server - Express + WebSocket proxy for AIS vessel tracking
 *
 * Uses AI-powered extraction (Google Gemini 2.0 Flash) to parse any Bill of Lading format.
 * No hardcoded patterns - the LLM understands shipping document semantics.
 * Gemini 2.0 Flash has a FREE tier: 15 RPM, 1500 RPD
 */

const express = require('express')
const cors = require('cors')
const { WebSocketServer, WebSocket } = require('ws')
const http = require('http')
const path = require('path')
const multer = require('multer')
const pdfParse = require('pdf-parse')
const { GoogleGenerativeAI } = require('@google/generative-ai')
const { getBottlenecks, checkBottleneckProximity } = require('./bottlenecks')
const { calculateRoute, estimateArrival } = require('./seaRoutes')

// Initialize Gemini client
const genAI = process.env.GEMINI_API_KEY
    ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
    : null

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

// In-memory vessel storage (populated from imports / live AIS)
let vesselDatabase = []
// Placeholder port lookup (populated dynamically via geocoding; kept empty to avoid hardcoded values)
const PORT_COORDINATES = {}

// Tracked vessels from AIS Stream
const trackedVessels = new Map()

// AIS Stream API Key (websocket) - supports both naming conventions
const AIS_API_KEY = process.env.AIS_API_KEY || process.env.AIRSTREAM_API || null
const DISABLE_AIS_STREAM = process.env.DISABLE_AIS_STREAM === 'true' || process.env.NO_AIS_STREAM === 'true'

// Marinesia API key (HTTP polling)
const MARINESIA_API_KEY = process.env.MARINESIA_API_KEY || process.env.MARINESIA_KEY || process.env.MARINESIA_TOKEN || null

// AIS Stream Connection
let aisSocket = null
const subscribedMmsi = new Set()
let subscriptionDebounce = null
let reconnectTimer = null

// Marinesia cache (per MMSI) to avoid over-polling
const marinesiaCache = new Map()


function ensureAISConnection() {
    if (!AIS_API_KEY || DISABLE_AIS_STREAM) return
    if (aisSocket && (aisSocket.readyState === WebSocket.OPEN || aisSocket.readyState === WebSocket.CONNECTING)) return

    aisSocket = new WebSocket('wss://stream.aisstream.io/v0/stream')

    aisSocket.on('open', () => {
        sendAisSubscription()
    })

    aisSocket.on('message', (event) => {
        try {
            const message = JSON.parse(event.data)
            handleAisMessage(message)
        } catch (err) {
            console.error('AIS message parse error', err.message)
        }
    })

    aisSocket.on('error', (err) => {
        console.error('AIS socket error', err.message)
    })

    aisSocket.on('close', () => {
        aisSocket = null
        if (reconnectTimer) clearTimeout(reconnectTimer)
        reconnectTimer = setTimeout(() => ensureAISConnection(), 4000)
    })
}

function sendAisSubscription() {
    if (!aisSocket || aisSocket.readyState !== WebSocket.OPEN) return
    if (subscribedMmsi.size === 0) return
    const payload = {
        APIKey: AIS_API_KEY,
        BoundingBoxes: [[[-90, -180], [90, 180]]],
        FiltersShipMMSI: Array.from(subscribedMmsi).slice(0, 50),
        FilterMessageTypes: ["PositionReport", "ShipStaticData", "ExtendedClassBPositionReport", "StandardClassBPositionReport", "StaticDataReport"]
    }
    aisSocket.send(JSON.stringify(payload))
}

function queueSubscriptionUpdate() {
    if (subscriptionDebounce) clearTimeout(subscriptionDebounce)
    subscriptionDebounce = setTimeout(() => sendAisSubscription(), 300)
}

function subscribeToMMSI(mmsi) {
    if (!mmsi) return
    subscribedMmsi.add(mmsi.toString())
    ensureAISConnection()
    queueSubscriptionUpdate()
}

async function handleAisMessage(message) {
    const meta = message.MetaData || {}
    const type = message.MessageType
    const body = message.Message?.[type] || {}

    let mmsi = meta.MMSI || body.UserID || body.MMSI || body.ShipMMSI
    if (!mmsi) return
    mmsi = mmsi.toString()

    const existing = trackedVessels.get(mmsi) || {}
    const updated = { ...existing, mmsi }

    const latitude = meta.latitude ?? meta.Latitude ?? body.Latitude
    const longitude = meta.longitude ?? meta.Longitude ?? body.Longitude
    if (latitude !== undefined && longitude !== undefined) {
        updated.latitude = Number(latitude)
        updated.longitude = Number(longitude)
    }

    if (body.Sog !== undefined) updated.speed = Number(body.Sog)
    if (body.Cog !== undefined) updated.cog = Number(body.Cog)
    if (body.TrueHeading !== undefined) updated.heading = Number(body.TrueHeading)

    const vesselName = meta.ShipName || body.Name
    if (vesselName) updated.name = vesselName.trim()
    if (meta.ShipType || body.Type) updated.shipType = meta.ShipType || body.Type

    const destinationName = meta.Destination || meta.ShipDestination || body.Destination
    if (destinationName) {
        updated.destination = destinationName.trim()
        if (!updated.destLat || !updated.destLng) {
            geocodePort(destinationName).then(coords => {
                if (coords) {
                    const current = trackedVessels.get(mmsi) || updated
                    trackedVessels.set(mmsi, {
                        ...current,
                        destLat: coords.lat,
                        destLng: coords.lon
                    })
                }
            })
        }
    }

    if (updated.latitude !== undefined && updated.longitude !== undefined) {
        updated.bottleneckWarning = checkBottleneckProximity(updated.latitude, updated.longitude)
    }

    if (updated.origin && updated.destination && updated.latitude !== undefined && updated.longitude !== undefined && updated.speed) {
        const route = calculateRoute(
            updated.originLat || updated.latitude,
            updated.originLng || updated.longitude,
            updated.destLat || updated.latitude,
            updated.destLng || updated.longitude,
            updated.origin,
            updated.destination
        )
        const etaCalc = estimateArrival(route, updated.latitude, updated.longitude, updated.speed || 12)
        if (etaCalc?.eta) updated.eta = etaCalc.eta
        updated.route = route
        updated.distanceRemainingNm = etaCalc?.distanceRemaining || null
        updated.hoursRemaining = etaCalc?.hoursRemaining || null
    }

    trackedVessels.set(mmsi, updated)
}

// Marinesia HTTP polling (works on Vercel without WebSockets)
const MARINESIA_TTL_MS = 60 * 1000

async function marinesiaRequest(pathname, params = {}) {
    if (!MARINESIA_API_KEY) {
        throw new Error('MARINESIA_API_KEY env is required for Marinesia API calls')
    }

    const url = new URL(`https://api.marinesia.com${pathname}`)
    Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
            url.searchParams.set(key, value)
        }
    })
    if (!url.searchParams.has('key')) {
        url.searchParams.set('key', MARINESIA_API_KEY)
    }

    const res = await fetch(url.toString())
    if (!res.ok) {
        throw new Error(`Marinesia error ${res.status}`)
    }
    const json = await res.json()
    if (json.error) {
        throw new Error(json.message || 'Marinesia responded with an error')
    }
    return json
}

function normalizeEta(etaString) {
    if (!etaString || typeof etaString !== 'string') return null
    // Marinesia ETA format: mm-dd hh:mm (UTC). Add current year and roll over if already passed.
    const match = etaString.match(/(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/)
    if (!match) return null
    const now = new Date()
    let etaUtc = Date.UTC(now.getUTCFullYear(), Number(match[1]) - 1, Number(match[2]), Number(match[3]), Number(match[4]))
    if (etaUtc < now.getTime()) {
        etaUtc = Date.UTC(now.getUTCFullYear() + 1, Number(match[1]) - 1, Number(match[2]), Number(match[3]), Number(match[4]))
    }
    return new Date(etaUtc).toISOString()
}

function normalizeMarinesiaLocation(data = {}) {
    return {
        mmsi: data.mmsi ? data.mmsi.toString() : null,
        latitude: data.lat ?? null,
        longitude: data.lng ?? null,
        speed: data.sog ?? null,
        cog: data.cog ?? null,
        heading: data.hdt ?? data.rot ?? null,
        destination: data.dest || null,
        eta: normalizeEta(data.eta),
        status: data.status,
        lastReport: data.ts || null,
        valid: data.valid
    }
}

function normalizeMarinesiaProfile(data = {}) {
    return {
        name: data.name || null,
        imo: data.imo || null,
        mmsi: data.mmsi ? data.mmsi.toString() : null,
        shipType: data.ship_type || data.type || null,
        flag: data.country || null,
        callsign: data.callsign || data.cs || null,
        length: data.length || data.l || null,
        width: data.width || data.w || null,
        vessel_type: data.type || null,
        image: data.image || null
    }
}

async function fetchMarinesiaLatest(mmsi, { force = false } = {}) {
    if (!mmsi || !MARINESIA_API_KEY) return null
    const key = mmsi.toString()
    const cached = marinesiaCache.get(key)
    if (cached && !force && Date.now() - cached.ts < MARINESIA_TTL_MS) {
        return cached.data
    }

    try {
        const [locRes, profileRes] = await Promise.all([
            marinesiaRequest(`/api/v1/vessel/${key}/location/latest`),
            marinesiaRequest(`/api/v1/vessel/${key}/profile`).catch(() => null)
        ])
        const location = normalizeMarinesiaLocation(locRes?.data || locRes)
        const profile = profileRes ? normalizeMarinesiaProfile(profileRes.data || profileRes) : {}
        const merged = { ...profile, ...location }

        // Geocode destination to support route drawing
        if (merged.destination && (!merged.destLat || !merged.destLng)) {
            const coords = await geocodePort(merged.destination)
            if (coords) {
                merged.destLat = coords.lat
                merged.destLng = coords.lon
            }
        }

        if (merged.latitude && merged.longitude) {
            merged.bottleneckWarning = checkBottleneckProximity(merged.latitude, merged.longitude)
        }

        marinesiaCache.set(key, { ts: Date.now(), data: merged })
        return merged
    } catch (err) {
        console.error('Marinesia latest fetch failed', err.message)
        return null
    }
}

async function searchMarinesiaByName(name) {
    if (!MARINESIA_API_KEY || !name) return []
    const variants = Array.from(new Set([
        name,
        name.toUpperCase(),
        name.toLowerCase(),
        name.split(/\s+/)[0]
    ].filter(Boolean)))

    const results = []
    for (const variant of variants) {
        try {
            const res = await marinesiaRequest('/api/v1/vessel/profile', { filters: `name:${variant}`, limit: 5 })
            if (Array.isArray(res.data)) {
                res.data.forEach(r => results.push(r))
            }
        } catch (err) {
            console.error('Marinesia search failed', variant, err.message)
        }
    }
    return results
}

async function refreshFromMarinesia(mmsi, { force = false } = {}) {
    const live = await fetchMarinesiaLatest(mmsi, { force })
    if (!live) return null

    const existing = trackedVessels.get(live.mmsi) || {}
    const merged = { ...existing, ...live }

    // Recalculate route/ETA if we have destination and live position
    if (merged.destination && merged.latitude && merged.longitude && merged.destLat && merged.destLng) {
        const route = calculateRoute(
            merged.originLat || merged.latitude,
            merged.originLng || merged.longitude,
            merged.destLat || merged.latitude,
            merged.destLng || merged.longitude,
            merged.origin || 'Current Position',
            merged.destination
        )
        const etaCalc = estimateArrival(route, merged.latitude, merged.longitude, merged.speed || 12)
        merged.route = route
        merged.eta = merged.eta || etaCalc?.eta
        merged.distanceRemainingNm = etaCalc?.distanceRemaining || null
        merged.hoursRemaining = etaCalc?.hoursRemaining || null
        merged.nextWaypoint = route[1] || null
    }

    trackedVessels.set(live.mmsi, merged)
    return merged
}

// Keep tracked vessels fresh for Vercel (HTTP polling every MARINESIA_TTL_MS)
setInterval(() => {
    if (!MARINESIA_API_KEY) return
    trackedVessels.forEach((_, mmsi) => {
        refreshFromMarinesia(mmsi).catch(err => console.error('Marinesia refresh interval failed', err.message))
    })
}, MARINESIA_TTL_MS)

// ============================================
// AI-POWERED PDF EXTRACTION
// Uses Google Gemini 3 Flash to intelligently extract shipping data from any B/L format
// FREE TIER available - get API key at https://aistudio.google.com/apikey
// ============================================

// Vision-based extraction for scanned PDFs
async function extractVesselDetailsFromPDFImage(pdfBuffer) {
    if (!genAI) {
        console.log('Gemini API not configured for vision extraction')
        return null
    }

    const prompt = `You are a shipping document parser. This is a scanned Bill of Lading document.
Extract vessel and shipping details from this document image.

Return ONLY a valid JSON object with these fields (use null for missing values):
{
  "vessel": "vessel/ship name",
  "voyage": "voyage number",
  "origin": "port of loading / place of receipt",
  "destination": "port of discharge / place of delivery / final destination",
  "eta": "estimated arrival date or shipped on board date",
  "blNumber": "bill of lading number",
  "shipper": "shipper/exporter name",
  "consignee": "consignee name"
}

Important rules:
- Extract the actual port/city names, not labels
- Vessel name should be just the ship name without voyage number
- Return ONLY valid JSON, no markdown code blocks, no explanation`

    try {
        const model = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' })

        // Send PDF as inline data for vision processing
        const result = await model.generateContent({
            contents: [{
                role: 'user',
                parts: [
                    {
                        inlineData: {
                            mimeType: 'application/pdf',
                            data: pdfBuffer.toString('base64')
                        }
                    },
                    { text: prompt }
                ]
            }],
            generationConfig: {
                temperature: 0,
                maxOutputTokens: 2000,
            }
        })

        const content = result.response.text() || '{}'
        console.log('Gemini vision response:', content.substring(0, 200))

        // Parse the JSON response
        const cleanContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
        const parsed = JSON.parse(cleanContent)

        console.log('Gemini vision extracted:', parsed)
        return {
            vessel: parsed.vessel || null,
            voyage: parsed.voyage || null,
            origin: parsed.origin || null,
            destination: parsed.destination || null,
            eta: parsed.eta || null,
            blNumber: parsed.blNumber || null,
            shipper: parsed.shipper || null,
            consignee: parsed.consignee || null
        }
    } catch (error) {
        console.error('Gemini vision extraction error:', error.message)
        return null
    }
}

async function extractVesselDetailsWithAI(text) {
    if (!text || text.trim().length < 50) {
        return { vessel: null, voyage: null, origin: null, destination: null, eta: null, blNumber: null }
    }

    if (!genAI) {
        console.log('Gemini API not configured, using basic extraction')
        return extractVesselDetailsBasic(text)
    }

    // Truncate text if too long
    const truncatedText = text.substring(0, 15000)

    const prompt = `You are a shipping document parser. Extract vessel and shipping details from this Bill of Lading text.

Return ONLY a valid JSON object with these fields (use null for missing values):
{
  "vessel": "vessel/ship name",
  "voyage": "voyage number",
  "origin": "port of loading / place of receipt",
  "destination": "port of discharge / place of delivery / final destination",
  "eta": "estimated arrival date or shipped on board date",
  "blNumber": "bill of lading number",
  "shipper": "shipper/exporter name",
  "consignee": "consignee name"
}

Important rules:
- Extract the actual port/city names, not labels like "PORT OF LOADING"
- Vessel name should be just the ship name without voyage number
- Voyage number is typically alphanumeric like "005S" or "0023"
- For destination, prefer the final delivery location if multiple ports are listed
- Return ONLY valid JSON, no markdown code blocks, no explanation

Bill of Lading text:
${truncatedText}`

    try {
        const model = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' })

        const result = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: {
                temperature: 0,
                maxOutputTokens: 2000,
            }
        })

        const content = result.response.text() || '{}'

        // Parse the JSON response
        let parsed
        try {
            // Remove any markdown code blocks if present
            const cleanContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
            parsed = JSON.parse(cleanContent)
        } catch (parseError) {
            console.error('Failed to parse Gemini response:', content)
            return extractVesselDetailsBasic(text)
        }

        console.log('Gemini extracted vessel details:', parsed)
        return {
            vessel: parsed.vessel || null,
            voyage: parsed.voyage || null,
            origin: parsed.origin || null,
            destination: parsed.destination || null,
            eta: parsed.eta || null,
            blNumber: parsed.blNumber || null,
            shipper: parsed.shipper || null,
            consignee: parsed.consignee || null
        }
    } catch (error) {
        console.error('Gemini extraction error:', error.message)
        // Fall back to basic extraction if AI fails
        return extractVesselDetailsBasic(text)
    }
}

// Basic fallback extraction (used when AI is unavailable)
function extractVesselDetailsBasic(text) {
    if (!text) return { vessel: null, voyage: null, origin: null, destination: null, eta: null, blNumber: null }

    const cleanText = text.replace(/\s+/g, ' ').toUpperCase()
    const result = { vessel: null, voyage: null, origin: null, destination: null, eta: null, blNumber: null }

    // Try to extract vessel name
    const vesselMatch = cleanText.match(/(?:VESSEL|OCEAN\s*VESSEL|SHIP)[:\s&]*(?:VOYAGE[:\s]*)?([A-Z][A-Z\s]{2,25}?)(?:\s*\d|$)/i)
    if (vesselMatch) result.vessel = vesselMatch[1].trim()

    // Try to extract voyage
    const voyageMatch = cleanText.match(/(?:VOYAGE|VOY)[:\s]*([0-9A-Z]{3,10})/i)
    if (voyageMatch) result.voyage = voyageMatch[1]

    // Try to extract B/L number
    const blMatch = cleanText.match(/(?:B\/L|BL|BILL)[:\s]*(?:NO)?[:\s]*([A-Z0-9]{6,20})/i)
    if (blMatch) result.blNumber = blMatch[1]

    // Heuristic port extraction: scan for known ports and map them to origin/destination
    const portMentions = []
    for (const key of Object.keys(PORT_COORDINATES)) {
        const idx = cleanText.indexOf(key)
        if (idx !== -1) {
            portMentions.push({ port: key, idx })
        }
    }
    portMentions.sort((a, b) => a.idx - b.idx)
    const prioritizedPorts = portMentions.filter(p => !['USA', 'UNITED STATES', 'NY', 'IL'].includes(p.port))
    const mentionsForPick = prioritizedPorts.length ? prioritizedPorts : portMentions

    const originKeywords = [
        'PLACE OF RECEIPT',
        'PORT OF LOADING',
        'PORT OF RECEIPT',
        'PORT OF ORIGIN',
        'LOAD PORT',
        'POL'
    ]
    const destinationKeywords = [
        'PORT OF DISCHARGE',
        'PLACE OF DELIVERY',
        'FINAL DESTINATION',
        'DELIVERY',
        'POD',
        'DESTINATION'
    ]

    const pickPort = (keywords, excludePort = null) => {
        let choice = null
        keywords.forEach(keyword => {
            let start = cleanText.indexOf(keyword)
            while (start !== -1) {
                mentionsForPick.forEach(match => {
                    if (excludePort && match.port === excludePort) return
                    const gap = match.idx - start
                    if (gap >= 0 && gap < 160) {
                        if (!choice || gap < choice.gap || (gap === choice.gap && match.port.length > choice.port.length)) {
                            choice = { ...match, gap }
                        }
                    }
                })
                start = cleanText.indexOf(keyword, start + keyword.length)
            }
        })
        return choice ? choice.port : null
    }

    const guessedOrigin = pickPort(originKeywords)
    const guessedDestination = pickPort(destinationKeywords, guessedOrigin)

    const firstPort = mentionsForPick[0]?.port || null
    const lastPort = mentionsForPick.length > 1
        ? mentionsForPick[mentionsForPick.length - 1].port
        : firstPort
    const secondPort = mentionsForPick.find(p => p.port !== firstPort)?.port || lastPort

    if (!result.origin && (guessedOrigin || firstPort)) {
        result.origin = guessedOrigin || firstPort
    }
    if (!result.destination && (guessedDestination || secondPort)) {
        result.destination = guessedDestination || secondPort
    }

    // Try to extract an ETA/date (common formats like NOV 11 2025 or 2025-11-11)
    const etaMatch = cleanText.match(/(\d{1,2}\s+(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\s+\d{4})|((JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\s+\d{1,2},?\s+\d{4})|(\d{4}-\d{2}-\d{2})/)
    if (etaMatch) {
        const normalizedEta = etaMatch[0]
            .replace(/(ST|ND|RD|TH)/g, '')
            .replace(/\s+/g, ' ')
            .trim()
        const parsedEta = Date.parse(normalizedEta)
        if (!isNaN(parsedEta)) {
            result.eta = new Date(parsedEta).toISOString()
        }
    }

    return result
}

// Port geocoding via live API (Nominatim OpenStreetMap)
const geocodeCache = new Map()

async function geocodePort(portName) {
    if (!portName) return null
    const cacheKey = portName.trim().toLowerCase()
    if (geocodeCache.has(cacheKey)) return geocodeCache.get(cacheKey)

    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(portName)}`
    try {
        const res = await fetch(url, {
            headers: { 'User-Agent': 'shipping-tracker/1.0 (+https://aisstream.io)' }
        })
        if (!res.ok) throw new Error(`geocode error ${res.status}`)
        const data = await res.json()
        const first = data && data[0]
        if (first) {
            const coords = { lat: Number(first.lat), lon: Number(first.lon) }
            geocodeCache.set(cacheKey, coords)
            return coords
        }
    } catch (err) {
        console.error('Geocode failed', portName, err.message)
    }

    geocodeCache.set(cacheKey, null)
    return null
}

// Fetch marine conditions for a coordinate (Open-Meteo free API)
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

function extractMmsiFromText(text) {
    if (!text) return null
    const match = text.toString().match(/\b(\d{9})\b/)
    return match ? match[1] : null
}

async function createVesselFromImport(details, rawText = '') {
    if (!details.vessel) return null

    // Resolve MMSI from document (prefer explicit MMSI, otherwise search by vessel name via Marinesia)
    const fromDoc = extractMmsiFromText(rawText)
    let resolvedMmsi = fromDoc
    if (!resolvedMmsi && details.vessel) {
        const matches = await searchMarinesiaByName(details.vessel)
        const best = matches.find(m => (m.name || '').toLowerCase().includes(details.vessel.toLowerCase())) || matches[0]
        resolvedMmsi = best?.mmsi?.toString()
    }

    if (!resolvedMmsi) {
        console.warn('No MMSI found in BL or Marinesia search; cannot create live vessel')
        return null
    }

    const live = await refreshFromMarinesia(resolvedMmsi, { force: true })
    if (!live) return null

    const vesselName = (details.vessel || live.name || '').toUpperCase().trim()

    // Get coordinates for origin and destination ports
    const originCoords = await geocodePort(details.origin || live.origin)
    const destCoords = await geocodePort(details.destination || live.destination)

    const vessel = {
        ...live,
        name: vesselName || live.name,
        mmsi: resolvedMmsi.toString(),
        destination: details.destination || live.destination || null,
        origin: details.origin || live.origin || null,
        voyage: details.voyage || live.voyage || live.voyageNo || null,
        voyageNo: details.voyage || live.voyage || live.voyageNo || null,
        blNumber: details.blNumber || live.blNumber || null,
        shipper: details.shipper || live.shipper || null,
        consignee: details.consignee || live.consignee || null,
        originLat: originCoords?.lat ?? live.originLat ?? null,
        originLng: originCoords?.lon ?? live.originLng ?? null,
        destLat: destCoords?.lat ?? live.destLat ?? null,
        destLng: destCoords?.lon ?? live.destLng ?? null,
        importedAt: new Date().toISOString()
    }

    // Recompute route + ETA with extracted ports and live position
    if (vessel.origin && vessel.destination && vessel.latitude && vessel.longitude && vessel.originLat && vessel.destLat) {
        const route = calculateRoute(
            vessel.originLat,
            vessel.originLng,
            vessel.destLat,
            vessel.destLng,
            vessel.origin,
            vessel.destination
        )
        const etaCalc = estimateArrival(route, vessel.latitude, vessel.longitude, vessel.speed || 12)
        vessel.route = route
        vessel.eta = vessel.eta || etaCalc?.eta
        vessel.distanceRemainingNm = etaCalc?.distanceRemaining || null
        vessel.hoursRemaining = etaCalc?.hoursRemaining || null
        vessel.nextWaypoint = route[1] || null
    }

    if (vessel.latitude && vessel.longitude) {
        vessel.bottleneckWarning = checkBottleneckProximity(vessel.latitude, vessel.longitude)
    }

    trackedVessels.set(vessel.mmsi, vessel)
    return vessel
}

// ============================================
// API ENDPOINTS
// ============================================

app.post('/api/import/bl', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' })

    try {
        const dataBuffer = req.file.buffer
        let details = { vessel: null }
        let text = ''
        let extractionMethod = 'none'
        let isScannedPDF = false

        console.log(`Processing PDF: ${req.file.originalname}, size: ${dataBuffer.length} bytes`)

        // Step 1: Extract text from PDF using pdf-parse
        try {
            const pdfData = await pdfParse(dataBuffer)
            text = pdfData.text || ''

            // Check if PDF is scanned (no extractable text)
            const cleanedText = text.replace(/\s+/g, '').trim()
            isScannedPDF = cleanedText.length < 50

            if (isScannedPDF) {
                console.log('PDF appears to be scanned (no extractable text)')
            } else {
                console.log(`Extracted ${text.length} characters from PDF`)
            }
        } catch (e) {
            console.error('pdf-parse error:', e.message)
        }

        // Step 2: Use AI to extract structured data
        if (process.env.GEMINI_API_KEY) {
            if (!isScannedPDF && text.length > 50) {
                // Use text-based AI extraction for digital PDFs
                console.log('Using AI text extraction with Gemini 3 Flash...')
                details = await extractVesselDetailsWithAI(text)
                extractionMethod = 'ai-gemini'
            } else {
                // Use vision-based extraction for scanned PDFs
                console.log('Using AI vision extraction with Gemini 3 Flash...')
                const visionDetails = await extractVesselDetailsFromPDFImage(dataBuffer)
                if (visionDetails && visionDetails.vessel) {
                    details = visionDetails
                    extractionMethod = 'ai-gemini-vision'
                    isScannedPDF = false // Successfully extracted, no need for error message
                }
            }
        } else if (!isScannedPDF && text.length > 50) {
            // Fall back to basic extraction if no API key
            console.log('No GEMINI_API_KEY set, using basic extraction...')
            details = extractVesselDetailsBasic(text)
            extractionMethod = 'basic-regex'
        }

        // Create vessel from extracted details (live AIS only)
        const vessel = await createVesselFromImport(details, text)

        if (vessel) {
            subscribeToMMSI(vessel.mmsi)
            // Update or add vessel to database
            const idx = vesselDatabase.findIndex(v => v.mmsi === vessel.mmsi)
            if (idx >= 0) {
                vesselDatabase[idx] = { ...vesselDatabase[idx], ...vessel }
            } else {
                vesselDatabase.push(vessel)
            }
            subscribeToMMSI(vessel.mmsi)
            console.log('Vessel imported:', vessel.name, vessel.mmsi)
        } else {
            console.log('Could not extract vessel details from PDF')
        }

        // Build response
        const response = {
            success: !!vessel,
            vessel,
            extractedDetails: details,
            extractionMethod,
            textLength: text.length
        }

        // Add helpful error message for scanned PDFs
        if (isScannedPDF && !vessel) {
            response.error = 'This PDF appears to be a scanned document. Please upload a digital PDF or enter vessel details manually.'
            response.isScannedPDF = true
        } else if (!vessel && text.length > 0) {
            if (!MARINESIA_API_KEY) {
                response.error = 'Could not find live AIS without MARINESIA_API_KEY. Add your key and include the vessel MMSI in the BL or name.'
            } else {
                response.error = 'Could not find live AIS for this vessel. Please ensure the MMSI is present in the BL or provide it manually.'
            }
            response.textSample = text.substring(0, 300)
        }

        res.json(response)
    } catch (error) {
        console.error('Import error:', error)
        res.status(500).json({
            error: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        })
    }
})

// Search vessels by MMSI or name (live AIS + imported)
app.get('/api/vessels/search', async (req, res) => {
    const query = (req.query.q || '').toString().trim()
    if (!query) return res.json({ vessels: [] })

    const numericMmsi = /^\d{6,9}$/.test(query) ? query : null

    if (numericMmsi) {
        subscribeToMMSI(numericMmsi)
        const live = await refreshFromMarinesia(numericMmsi, { force: true })
        const vesselFromStore = live ||
            trackedVessels.get(numericMmsi) ||
            vesselDatabase.find(v => v.mmsi === numericMmsi)
        return res.json({ vessels: vesselFromStore ? [vesselFromStore] : [] })
    }

    const lower = query.toLowerCase()
    const candidates = [
        ...trackedVessels.values(),
        ...vesselDatabase
    ]
    const localMatches = candidates.filter(v => (v.name || '').toLowerCase().includes(lower))

    // Try live name search via Marinesia to avoid hardcoded seeds
    const remoteProfiles = await searchMarinesiaByName(query)
    const enrichedRemote = []
    for (const profile of remoteProfiles) {
        const mmsi = profile.mmsi || profile.MMSI
        if (!mmsi) continue
        subscribeToMMSI(mmsi)
        const live = await refreshFromMarinesia(mmsi, { force: true })
        if (live) {
            enrichedRemote.push(live)
        } else {
            enrichedRemote.push(normalizeMarinesiaProfile(profile))
        }
    }

    const combined = [...localMatches, ...enrichedRemote].filter(Boolean)
    const unique = Array.from(new Map(combined.map(v => [v.mmsi || v.name, v])).values())

    res.json({ vessels: unique })
})

app.get('/api/vessels', async (req, res) => {
    if (MARINESIA_API_KEY && trackedVessels.size > 0) {
        await Promise.all(Array.from(trackedVessels.keys()).map(mmsi => refreshFromMarinesia(mmsi).catch(() => null)))
    }

    const vessels = Array.from(trackedVessels.values())
    const allVessels = [...vesselDatabase.map(v => ({
        ...v,
        bottleneckWarning: checkBottleneckProximity(v.latitude, v.longitude)
    })), ...vessels]
    const uniqueVessels = Array.from(new Map(allVessels.map(v => [v.mmsi, v])).values())
    res.json({ vessels: uniqueVessels })
})

app.get('/api/bottlenecks', (req, res) => {
    res.json({ bottlenecks: getBottlenecks() })
})

// Vessel details with live weather and computed route/ETA
app.get('/api/vessels/:mmsi/details', async (req, res) => {
    const mmsi = req.params.mmsi?.toString()
    if (!mmsi) return res.status(400).json({ error: 'mmsi required' })
    await refreshFromMarinesia(mmsi, { force: true })
    const vessel = trackedVessels.get(mmsi) || vesselDatabase.find(v => v.mmsi === mmsi)
    if (!vessel) return res.status(404).json({ error: 'not found' })

    const enriched = { ...vessel }

    if (enriched.latitude && enriched.longitude) {
        enriched.weather = await getMarineConditions(enriched.latitude, enriched.longitude)
    }

    if (enriched.origin && enriched.destination && enriched.latitude && enriched.longitude) {
        const route = calculateRoute(
            enriched.originLat || enriched.latitude,
            enriched.originLng || enriched.longitude,
            enriched.destLat || enriched.latitude,
            enriched.destLng || enriched.longitude,
            enriched.origin,
            enriched.destination
        )
        const etaCalc = estimateArrival(route, enriched.latitude, enriched.longitude, enriched.speed || 12)
        enriched.route = route
        enriched.eta = enriched.eta || etaCalc?.eta
        enriched.distanceRemainingNm = etaCalc?.distanceRemaining || null
        enriched.hoursRemaining = etaCalc?.hoursRemaining || null
        enriched.nextWaypoint = route[1] || null
    }

    res.json({ vessel: enriched })
})

app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date() }))

// Serve static files
if (process.env.NODE_ENV === 'production') {
    console.log('Production mode detected, serving from dist/')
    app.use(express.static(path.join(__dirname, 'dist')))
    app.get(/.*/, (req, res, next) => {
        // Skip API routes
        if (req.path.startsWith('/api') || req.path.startsWith('/ws')) {
            return next()
        }
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
        ws.send(JSON.stringify({ type: 'vessels', data: unique }))
    }, 5000)
    ws.on('close', () => clearInterval(interval))
})

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`)
    console.log(`Node Environment: ${process.env.NODE_ENV}`)
})

module.exports = app
