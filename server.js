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

// AIS Stream Connection
let aisSocket = null
const subscribedMmsi = new Set()
let subscriptionDebounce = null
let reconnectTimer = null

function ensureAISConnection() {
    if (!AIS_API_KEY) {
        console.log('No AIS_API_KEY/AIRSTREAM_API configured')
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
    if (subscribedMmsi.size === 0) {
        // Subscribe to global bounding box if no specific MMSIs
        console.log('Subscribing to global AIS feed...')
    }
    const payload = {
        APIKey: AIS_API_KEY,
        BoundingBoxes: [[[-90, -180], [90, 180]]],
        FiltersShipMMSI: subscribedMmsi.size > 0 ? Array.from(subscribedMmsi).slice(0, 50) : undefined,
        FilterMessageTypes: ["PositionReport", "ShipStaticData", "ExtendedClassBPositionReport", "StandardClassBPositionReport", "StaticDataReport"]
    }
    aisSocket.send(JSON.stringify(payload))
    console.log('AIS subscription sent for', subscribedMmsi.size, 'vessels')
}

function queueSubscriptionUpdate() {
    if (subscriptionDebounce) clearTimeout(subscriptionDebounce)
    subscriptionDebounce = setTimeout(() => sendAisSubscription(), 300)
}

function subscribeToMMSI(mmsi) {
    if (!mmsi || mmsi.toString().startsWith('SIM')) return // Don't subscribe simulated vessels
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

// Search for vessel MMSI by name using multiple free vessel databases
async function searchVesselByName(vesselName) {
    if (!vesselName) return null

    const cleanName = vesselName.trim().toUpperCase()
    console.log('Searching for vessel MMSI:', cleanName)

    // Try multiple search variations
    const searchVariants = [
        cleanName,
        cleanName.replace(/\s+/g, ''),  // No spaces
        cleanName.split(/\s+/)[0],       // First word only
    ]

    for (const searchTerm of searchVariants) {
        // 1. Try MyShipTracking public search (scrape-friendly)
        try {
            const url = `https://www.myshiptracking.com/requests/autocomplete-ede42.php?term=${encodeURIComponent(searchTerm)}`
            const res = await fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; ShippingTracker/1.0)',
                    'Accept': 'application/json',
                    'Referer': 'https://www.myshiptracking.com/'
                }
            })
            if (res.ok) {
                const data = await res.json()
                if (data && Array.isArray(data) && data.length > 0) {
                    const match = data.find(v => {
                        const name = (v.label || v.value || '').toUpperCase()
                        return name.includes(cleanName) || cleanName.includes(name.split(' ')[0])
                    }) || data[0]

                    // Extract MMSI from the result (format varies)
                    const mmsiMatch = (match.value || match.label || '').match(/\b(\d{9})\b/)
                    if (mmsiMatch) {
                        console.log('Found vessel via MyShipTracking:', match.label, mmsiMatch[1])
                        return {
                            mmsi: mmsiMatch[1],
                            name: (match.label || '').split(' - ')[0].trim(),
                            source: 'myshiptracking'
                        }
                    }
                }
            }
        } catch (err) {
            console.log('MyShipTracking search failed:', err.message)
        }

        // 2. Try MarineTraffic public search
        try {
            const url = `https://www.marinetraffic.com/en/ais/index/search/all/keyword:${encodeURIComponent(searchTerm)}`
            const res = await fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; ShippingTracker/1.0)',
                    'Accept': 'text/html'
                }
            })
            if (res.ok) {
                const html = await res.text()
                // Look for MMSI in the search results page
                const mmsiMatch = html.match(/mmsi["\s:=]+(\d{9})/i)
                const nameMatch = html.match(/ship_name["\s:=]+["']?([^"'<>]+)/i)
                if (mmsiMatch) {
                    console.log('Found vessel via MarineTraffic:', nameMatch?.[1] || searchTerm, mmsiMatch[1])
                    return {
                        mmsi: mmsiMatch[1],
                        name: nameMatch?.[1] || searchTerm,
                        source: 'marinetraffic'
                    }
                }
            }
        } catch (err) {
            console.log('MarineTraffic search failed:', err.message)
        }

        // 3. Try Datalastic demo API
        try {
            const url = `https://api.datalastic.com/api/v0/vessel?api-key=demo&name=${encodeURIComponent(searchTerm)}`
            const res = await fetch(url)
            if (res.ok) {
                const data = await res.json()
                if (data && data.data && data.data.length > 0) {
                    const match = data.data[0]
                    if (match.mmsi) {
                        console.log('Found vessel via Datalastic:', match.name, match.mmsi)
                        return {
                            mmsi: match.mmsi.toString(),
                            name: match.name,
                            imo: match.imo,
                            type: match.vessel_type,
                            flag: match.flag,
                            source: 'datalastic'
                        }
                    }
                }
            }
        } catch (err) {
            console.log('Datalastic search failed:', err.message)
        }

        // 4. Try VesselFinder public API
        try {
            const searchUrl = `https://www.vesselfinder.com/api/pub/search/v1?s=${encodeURIComponent(searchTerm)}`
            const res = await fetch(searchUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'application/json'
                }
            })
            if (res.ok) {
                const data = await res.json()
                if (data && Array.isArray(data) && data.length > 0) {
                    const match = data[0]
                    if (match.mmsi) {
                        console.log('Found vessel via VesselFinder:', match.name, match.mmsi)
                        return {
                            mmsi: match.mmsi.toString(),
                            name: match.name,
                            imo: match.imo,
                            type: match.type,
                            flag: match.flag,
                            source: 'vesselfinder'
                        }
                    }
                }
            }
        } catch (err) {
            console.log('VesselFinder search failed:', err.message)
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
        console.error('ERROR: Could not find MMSI for vessel:', vesselName)
        console.error('Please provide the MMSI number in the Bill of Lading or manually')
        return null
    }

    // Get coordinates for origin and destination ports
    const originCoords = await geocodePort(details.origin)
    const destCoords = await geocodePort(details.destination)

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
        importedAt: new Date().toISOString()
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
    res.json({ vessels: unique })
})

app.get('/api/vessels', async (req, res) => {
    const vessels = Array.from(trackedVessels.values())
    const allVessels = [...vesselDatabase.map(v => ({
        ...v,
        bottleneckWarning: v.latitude && v.longitude ? checkBottleneckProximity(v.latitude, v.longitude) : null
    })), ...vessels]
    const uniqueVessels = Array.from(new Map(allVessels.map(v => [v.mmsi, v])).values())
    res.json({ vessels: uniqueVessels })
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
        ws.send(JSON.stringify({ type: 'vessels', data: unique }))
    }, 5000)
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
