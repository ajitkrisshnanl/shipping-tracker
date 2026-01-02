/**
 * Backend Server - Express + WebSocket for AIS vessel tracking
 *
 * Uses AI-powered extraction (Google Gemini 3 Flash) to parse any Bill of Lading format.
 * Uses AIS Stream (Airstream) WebSocket for live vessel tracking.
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

// In-memory vessel storage
let vesselDatabase = []
const trackedVessels = new Map()

// AIS Stream API Key (Airstream WebSocket)
const AIS_API_KEY = process.env.AIS_API_KEY || process.env.AIRSTREAM_API || null
const DISABLE_AIS_STREAM = process.env.DISABLE_AIS_STREAM === 'true'

// AIS Stream Connection
let aisSocket = null
const subscribedMmsi = new Set()
let subscriptionDebounce = null
let reconnectTimer = null

// Dynamic bounding boxes for AIS subscriptions (start with global; add smaller boxes when hunting by name)
const dynamicBoundingBoxes = new Set([JSON.stringify([[-90, -180], [90, 180]])])

// Pending vessel name hunts (when MMSI is unknown). Keyed by normalized name.
const pendingNameLookups = new Map()

function addBoundingBox(box) {
    if (!Array.isArray(box) || box.length !== 2) return
    const key = JSON.stringify(box)
    if (!dynamicBoundingBoxes.has(key)) {
        dynamicBoundingBoxes.add(key)
        queueSubscriptionUpdate()
    }
}

function getBoundingBoxesForSubscription() {
    const boxes = Array.from(dynamicBoundingBoxes).map((b) => JSON.parse(b))
    return boxes.length ? boxes : [[[-90, -180], [90, 180]]]
}
function ensureAISConnection() {
    if (!AIS_API_KEY || DISABLE_AIS_STREAM) {
        if (!AIS_API_KEY) console.log('No AIS_API_KEY/AIRSTREAM_API configured')
        return
    }
    if (aisSocket && (aisSocket.readyState === WebSocket.OPEN || aisSocket.readyState === WebSocket.CONNECTING)) return

    console.log('Connecting to AIS Stream...')
    aisSocket = new WebSocket('wss://stream.aisstream.io/v0/stream')

    aisSocket.on('open', () => {
        console.log('AIS Stream connected')
        sendAisSubscription()
    })

    aisSocket.on('message', (event) => {
        try {
            // Handle both string and Buffer data
            const data = typeof event === 'string' ? event : event.toString()
            if (!data || data === 'undefined') return
            const message = JSON.parse(data)
            handleAisMessage(message)
        } catch (err) {
            // Only log if it's an actual parse error, not empty messages
            if (err.message !== "Unexpected token 'u', \"undefined\" is not valid JSON") {
                console.error('AIS message parse error:', err.message)
            }
        }
    })

    aisSocket.on('error', (err) => {
        console.error('AIS socket error', err.message)
    })

    aisSocket.on('close', () => {
        console.log('AIS Stream disconnected, reconnecting...')
        aisSocket = null
        if (reconnectTimer) clearTimeout(reconnectTimer)
        reconnectTimer = setTimeout(() => ensureAISConnection(), 4000)
    })
}

function sendAisSubscription() {
    if (!aisSocket || aisSocket.readyState !== WebSocket.OPEN) return
    const boxes = getBoundingBoxesForSubscription()
    const payload = {
        APIKey: AIS_API_KEY,
        BoundingBoxes: boxes,
        FiltersShipMMSI: subscribedMmsi.size > 0 ? Array.from(subscribedMmsi).slice(0, 50) : undefined,
        FilterMessageTypes: ["PositionReport", "ShipStaticData", "ExtendedClassBPositionReport", "StandardClassBPositionReport", "StaticDataReport"]
    }
    aisSocket.send(JSON.stringify(payload))
    console.log('AIS subscription sent for', subscribedMmsi.size, 'vessels', 'boxes:', boxes.length)
}

function queueSubscriptionUpdate() {
    if (subscriptionDebounce) clearTimeout(subscriptionDebounce)
    subscriptionDebounce = setTimeout(() => sendAisSubscription(), 300)
}

function subscribeToMMSI(mmsi) {
    if (!mmsi || mmsi.toString().startsWith('SIM') || mmsi.toString().startsWith('PENDING')) return // Don't subscribe simulated/pending vessels
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

    // Update route/ETA if we have origin and destination
    if (updated.origin && updated.destination && updated.latitude && updated.longitude) {
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

    // If this matches a pending name hunt, bind the MMSI and upgrade the record
    const normName = normalizeName(vesselName || '')
    if (normName && pendingNameLookups.has(normName)) {
        const pending = pendingNameLookups.get(normName)
        pendingNameLookups.delete(normName)

        const seeded = pending.seed || {}
        // Remove pending placeholder
        if (pending.pendingId) {
            trackedVessels.delete(pending.pendingId)
            const idx = vesselDatabase.findIndex(v => v.mmsi === pending.pendingId)
            if (idx >= 0) vesselDatabase.splice(idx, 1)
        }

        updated.origin = updated.origin || seeded.origin
        updated.destination = updated.destination || seeded.destination
        updated.originLat = updated.originLat || seeded.originLat
        updated.originLng = updated.originLng || seeded.originLng
        updated.destLat = updated.destLat || seeded.destLat
        updated.destLng = updated.destLng || seeded.destLng
        updated.route = updated.route || seeded.route
        updated.eta = updated.eta || seeded.eta
        updated.searching = false
        updated.searchSource = 'aisstream-name-hunt'
        updated.updatedAt = new Date().toISOString()

        subscribeToMMSI(mmsi)
        console.log('Bound pending vessel to MMSI via AIS name match:', vesselName, mmsi)
    }

    updated.updatedAt = new Date().toISOString()
    trackedVessels.set(mmsi, updated)

    // Also update vesselDatabase if this vessel was imported
    const dbIdx = vesselDatabase.findIndex(v => v.mmsi === mmsi)
    if (dbIdx >= 0) {
        vesselDatabase[dbIdx] = { ...vesselDatabase[dbIdx], ...updated }
    }
}

// ============================================
// AI-POWERED PDF EXTRACTION
// ============================================

async function extractVesselDetailsFromPDFImage(pdfBuffer) {
    if (!genAI) return null

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
  "consignee": "consignee name",
  "mmsi": "9-digit MMSI number if visible"
}

Important rules:
- Extract the actual port/city names, not labels
- Vessel name should be just the ship name without voyage number
- Return ONLY valid JSON, no markdown code blocks, no explanation`

    try {
        const model = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' })
        const result = await model.generateContent({
            contents: [{
                role: 'user',
                parts: [
                    { inlineData: { mimeType: 'application/pdf', data: pdfBuffer.toString('base64') } },
                    { text: prompt }
                ]
            }],
            generationConfig: { temperature: 0, maxOutputTokens: 2000 }
        })

        const content = result.response.text() || '{}'
        const cleanContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
        const parsed = JSON.parse(cleanContent)
        console.log('Gemini vision extracted:', parsed)
        return parsed
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
        console.log('Gemini API not configured')
        return { vessel: null, voyage: null, origin: null, destination: null, eta: null, blNumber: null }
    }

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
  "consignee": "consignee name",
  "mmsi": "9-digit MMSI number if visible"
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
            generationConfig: { temperature: 0, maxOutputTokens: 2000 }
        })

        const content = result.response.text() || '{}'
        const cleanContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
        const parsed = JSON.parse(cleanContent)
        console.log('Gemini extracted vessel details:', parsed)
        return parsed
    } catch (error) {
        console.error('Gemini extraction error:', error.message)
        return { vessel: null, voyage: null, origin: null, destination: null, eta: null, blNumber: null }
    }
}

// Port geocoding via Nominatim OpenStreetMap
const geocodeCache = new Map()

async function geocodePort(portName) {
    if (!portName) return null
    const cacheKey = portName.trim().toLowerCase()
    if (geocodeCache.has(cacheKey)) return geocodeCache.get(cacheKey)

    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(portName)}`
    try {
        const res = await fetch(url, {
            headers: { 'User-Agent': 'shipping-tracker/1.0' }
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

function extractMmsiFromText(text) {
    if (!text) return null
    const match = text.toString().match(/\b(\d{9})\b/)
    return match ? match[1] : null
}

function normalizeName(name) {
    return (name || '').toString().toUpperCase().replace(/[^A-Z0-9]/g, '')
}

function buildBoundingBox(lat, lon, km = 250) {
    if (!lat || !lon) return null
    const d = km / 111 // approx degrees per km
    return [
        [lat + d, lon - d],
        [lat - d, lon + d]
    ]
}

function startNameHunt(targetName, boundingBoxes, seed) {
    const norm = normalizeName(targetName)
    if (!norm) return
    pendingNameLookups.set(norm, {
        pendingId: seed?.mmsi,
        targetName: targetName,
        seed,
        boxes: boundingBoxes
    })
    ;(boundingBoxes || []).forEach(addBoundingBox)
    queueSubscriptionUpdate()
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

    console.log('Could not find MMSI for vessel:', cleanName)
    return null
}

async function createVesselFromImport(details, rawText = '') {
    if (!details.vessel) return null

    const vesselName = (details.vessel || '').toUpperCase().trim()

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

    // If still no MMSI, we cannot track this vessel with real AIS data
    if (!mmsi) {
        console.warn('No MMSI found; starting AIS name hunt:', vesselName)

        const originCoords = await geocodePort(details.origin)
        const destCoords = await geocodePort(details.destination)
        const boxes = []
        const originBox = buildBoundingBox(originCoords?.lat, originCoords?.lon, 250)
        const destBox = buildBoundingBox(destCoords?.lat, destCoords?.lon, 250)
        if (originBox) boxes.push(originBox)
        if (destBox) boxes.push(destBox)
        if (boxes.length === 0) {
            // fallback to wide box if we have nothing
            boxes.push([[-90, -180], [90, 180]])
        }

        const pendingId = `PENDING-${Date.now()}-${Math.floor(Math.random() * 1000)}`
        const placeholder = {
            mmsi: pendingId,
            name: vesselName,
            origin: details.origin || null,
            destination: details.destination || null,
            voyage: details.voyage || null,
            voyageNo: details.voyage || null,
            blNumber: details.blNumber || null,
            shipper: details.shipper || null,
            consignee: details.consignee || null,
            originLat: originCoords?.lat ?? null,
            originLng: originCoords?.lon ?? null,
            destLat: destCoords?.lat ?? null,
            destLng: destCoords?.lon ?? null,
            route: (originCoords && destCoords) ? calculateRoute(
                originCoords.lat, originCoords.lon, destCoords.lat, destCoords.lon, details.origin, details.destination
            ) : null,
            eta: details.eta || null,
            searching: true,
            status: 'Searching AIS by name',
            importedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        }

        trackedVessels.set(pendingId, placeholder)
        vesselDatabase.push(placeholder)
        startNameHunt(vesselName, boxes, { ...placeholder })
        return placeholder
    }

    // Get coordinates for origin and destination ports
    const originCoords = await geocodePort(details.origin)
    const destCoords = await geocodePort(details.destination)
    console.log('Geocode results:', { origin: details.origin, originCoords, destination: details.destination, destCoords })

    const vessel = {
        mmsi: mmsi.toString(),
        name: vesselInfo?.name || vesselName,
        imo: vesselInfo?.imo || null,
        flag: vesselInfo?.flag || null,
        shipType: vesselInfo?.type || null,
        destination: details.destination || null,
        origin: details.origin || null,
        voyage: details.voyage || null,
        voyageNo: details.voyage || null,
        blNumber: details.blNumber || null,
        shipper: details.shipper || null,
        consignee: details.consignee || null,
        originLat: originCoords?.lat ?? null,
        originLng: originCoords?.lon ?? null,
        destLat: destCoords?.lat ?? null,
        destLng: destCoords?.lon ?? null,
        // Position will be updated by Airstream
        latitude: null,
        longitude: null,
        speed: null,
        importedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    }

    // Compute route (ETA will be calculated once we get live position from Airstream)
    if (vessel.origin && vessel.destination && vessel.originLat && vessel.destLat) {
        const route = calculateRoute(
            vessel.originLat,
            vessel.originLng,
            vessel.destLat,
            vessel.destLng,
            vessel.origin,
            vessel.destination
        )
        vessel.route = route
        vessel.eta = details.eta || null
        vessel.nextWaypoint = route[1] || null
        console.log('Route calculated:', route.length, 'waypoints')
    } else {
        console.log('Route NOT calculated - missing coords:', { originLat: vessel.originLat, originLng: vessel.originLng, destLat: vessel.destLat, destLng: vessel.destLng })
    }

    trackedVessels.set(vessel.mmsi, vessel)

    // Subscribe to Airstream for live AIS updates
    subscribeToMMSI(vessel.mmsi)
    console.log('Subscribed to Airstream for vessel:', vessel.name, vessel.mmsi)

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

        // Step 2: Use AI to extract structured data
        if (process.env.GEMINI_API_KEY) {
            if (!isScannedPDF && text.length > 50) {
                console.log('Using AI text extraction...')
                details = await extractVesselDetailsWithAI(text)
                extractionMethod = 'ai-gemini'
            } else {
                console.log('Using AI vision extraction...')
                const visionDetails = await extractVesselDetailsFromPDFImage(dataBuffer)
                if (visionDetails && visionDetails.vessel) {
                    details = visionDetails
                    extractionMethod = 'ai-gemini-vision'
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
            response.error = `Could not find MMSI for vessel "${details.vessel}". The vessel may not be in global AIS databases. Try adding the 9-digit MMSI number to the Bill of Lading.`
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
    const query = (req.query.q || '').toString().trim().toLowerCase()
    if (!query) return res.json({ vessels: [] })

    const candidates = [...trackedVessels.values(), ...vesselDatabase]
    const matches = candidates.filter(v =>
        (v.name || '').toLowerCase().includes(query) ||
        (v.mmsi || '').toString().includes(query)
    )
    const unique = Array.from(new Map(matches.map(v => [v.mmsi, v])).values())
    res.json({ vessels: unique.slice(0, 10) })
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
    res.json({ vessels: sorted.slice(0, 10) })
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

app.get('/api/health', (req, res) => res.json({
    status: 'ok',
    timestamp: new Date(),
    aisConnected: aisSocket?.readyState === WebSocket.OPEN,
    trackedVessels: trackedVessels.size
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
        ws.send(JSON.stringify({ type: 'vessels', data: sorted.slice(0, 10) }))
    }, 30000)
    ws.on('close', () => clearInterval(interval))
})

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`)
    console.log(`AIS API Key configured: ${!!AIS_API_KEY}`)
    console.log(`Gemini API Key configured: ${!!process.env.GEMINI_API_KEY}`)

    // Start AIS connection if we have API key
    if (AIS_API_KEY) {
        ensureAISConnection()
    }
})

module.exports = app
