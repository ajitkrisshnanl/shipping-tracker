/**
 * Carrier Tracking Module
 * Detects shipping carriers and provides tracking URLs/ETAs
 */

const DEFAULT_FETCH_TIMEOUT_MS = 15000

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
    const controller = new AbortController()
    const id = setTimeout(() => controller.abort(), timeoutMs)
    try {
        return await fetch(url, { ...options, signal: controller.signal })
    } catch (err) {
        if (err?.name === 'AbortError') {
            throw new Error(`Request timeout after ${timeoutMs}ms`)
        }
        throw err
    } finally {
        clearTimeout(id)
    }
}

// Carrier definitions with BL prefixes and tracking URLs
const CARRIERS = {
    maersk: {
        name: 'Maersk',
        aliases: ['maersk', 'sealand', 'safmarine', 'maersk line'],
        blPrefixes: ['MAEU', 'MSKU', 'SEAU', 'SAFM'],
        trackingUrl: (blNumber) => `https://www.maersk.com/tracking/${blNumber}`,
        apiEndpoint: 'https://api.maersk.com/track',
        color: '#00243D'
    },
    msc: {
        name: 'MSC',
        aliases: ['msc', 'mediterranean shipping company', 'mediterranean shipping'],
        blPrefixes: ['MSCU', 'MEDU'],
        trackingUrl: (blNumber) => `https://www.msc.com/track-a-shipment?agencyPath=msc&trackingNumber=${blNumber}`,
        color: '#002B5C'
    },
    cma_cgm: {
        name: 'CMA CGM',
        aliases: ['cma cgm', 'cma-cgm', 'apl', 'anl'],
        blPrefixes: ['CMAU', 'APLU', 'ANLU'],
        trackingUrl: (blNumber) => `https://www.cma-cgm.com/ebusiness/tracking/search?SearchBy=BL&Reference=${blNumber}`,
        color: '#002F6C'
    },
    hapag_lloyd: {
        name: 'Hapag-Lloyd',
        aliases: ['hapag-lloyd', 'hapag lloyd', 'hapag'],
        blPrefixes: ['HLCU', 'HLXU'],
        trackingUrl: (blNumber) => `https://www.hapag-lloyd.com/en/online-business/track/track-by-booking-solution.html?blno=${blNumber}`,
        color: '#FF6600'
    },
    one: {
        name: 'ONE (Ocean Network Express)',
        aliases: ['one', 'ocean network express'],
        blPrefixes: ['ONEY', 'ONEU'],
        trackingUrl: (blNumber) => `https://ecomm.one-line.com/one-ecom/manage-shipment/cargo-tracking?trakNoParam=${blNumber}`,
        color: '#FF1493'
    },
    evergreen: {
        name: 'Evergreen',
        aliases: ['evergreen', 'evergreen line', 'evergreen marine'],
        blPrefixes: ['EISU', 'EGHU', 'EMCU'],
        trackingUrl: (blNumber) => `https://www.shipmentlink.com/servlet/TDB1_CargoTracking.do?BkgNo=${blNumber}`,
        color: '#006400'
    },
    oocl: {
        name: 'OOCL',
        aliases: ['oocl', 'orient overseas container line'],
        blPrefixes: ['OOLU'],
        trackingUrl: (blNumber) => `https://www.oocl.com/eng/ourservices/eservices/cargotracking/Pages/cargotracking.aspx?ref=${blNumber}`,
        color: '#003366'
    },
    cosco: {
        name: 'COSCO',
        aliases: ['cosco', 'cosco shipping', 'oocl'],
        blPrefixes: ['COSU', 'CBHU'],
        trackingUrl: (blNumber) => `https://elines.coscoshipping.com/ebusiness/cargoTracking?trackingType=BOOKING&number=${blNumber}`,
        color: '#003399'
    },
    yang_ming: {
        name: 'Yang Ming',
        aliases: ['yang ming', 'yangming'],
        blPrefixes: ['YMLU', 'YMMU'],
        trackingUrl: (blNumber) => `https://www.yangming.com/e-service/track_trace/track_trace_cargo_tracking.aspx?rdolType=BL&txtTrackNo=${blNumber}`,
        color: '#FFD700'
    },
    pil: {
        name: 'PIL (Pacific International Lines)',
        aliases: ['pil', 'pacific international lines'],
        blPrefixes: ['PCIU'],
        trackingUrl: (blNumber) => `https://www.pilship.com/en--/120.html?ESSION_BKGNO=${blNumber}`,
        color: '#0066CC'
    },
    zim: {
        name: 'ZIM',
        aliases: ['zim', 'zim integrated shipping'],
        blPrefixes: ['ZIMU'],
        trackingUrl: (blNumber) => `https://www.zim.com/tools/track-a-shipment?consnumber=${blNumber}`,
        color: '#00529B'
    },
    wan_hai: {
        name: 'Wan Hai Lines',
        aliases: ['wan hai', 'wanhai'],
        blPrefixes: ['WHLU'],
        trackingUrl: (blNumber) => `https://www.wanhai.com/views/cargoTrack/CargoTrack.xhtml?file=cargo_tracking&key=${blNumber}`,
        color: '#003366'
    },
    hyundai: {
        name: 'HMM (Hyundai Merchant Marine)',
        aliases: ['hmm', 'hyundai', 'hyundai merchant marine'],
        blPrefixes: ['HDMU'],
        trackingUrl: (blNumber) => `https://www.hmm21.com/cms/business/ebiz/trackTrace/trackTrace/index.jsp?blNo=${blNumber}`,
        color: '#FF6600'
    }
}

/**
 * Detect carrier from BL number prefix
 * @param {string} blNumber - Bill of Lading number
 * @returns {Object|null} - Carrier info or null if not detected
 */
function detectCarrierFromBL(blNumber) {
    if (!blNumber || typeof blNumber !== 'string') return null

    const upperBL = blNumber.toUpperCase().replace(/\s+/g, '')

    for (const [carrierId, carrier] of Object.entries(CARRIERS)) {
        for (const prefix of carrier.blPrefixes) {
            if (upperBL.startsWith(prefix)) {
                return {
                    id: carrierId,
                    name: carrier.name,
                    detectedFrom: 'bl_prefix',
                    prefix: prefix
                }
            }
        }
    }

    return null
}

/**
 * Detect carrier from carrier name string
 * @param {string} carrierName - Carrier name from BL extraction
 * @returns {Object|null} - Carrier info or null if not detected
 */
function detectCarrierFromName(carrierName) {
    if (!carrierName || typeof carrierName !== 'string') return null

    const lowerName = carrierName.toLowerCase().trim()

    for (const [carrierId, carrier] of Object.entries(CARRIERS)) {
        // Check exact name match
        if (lowerName === carrier.name.toLowerCase()) {
            return {
                id: carrierId,
                name: carrier.name,
                detectedFrom: 'carrier_name'
            }
        }

        // Check aliases
        for (const alias of carrier.aliases) {
            if (lowerName.includes(alias)) {
                return {
                    id: carrierId,
                    name: carrier.name,
                    detectedFrom: 'carrier_alias'
                }
            }
        }
    }

    return null
}

/**
 * Detect carrier from container number prefix
 * @param {string} containerNumber - Container number (e.g., MSKU1234567)
 * @returns {Object|null} - Carrier info or null if not detected
 */
function detectCarrierFromContainer(containerNumber) {
    if (!containerNumber || typeof containerNumber !== 'string') return null

    const upperContainer = containerNumber.toUpperCase().replace(/\s+/g, '')
    const prefix = upperContainer.substring(0, 4)

    for (const [carrierId, carrier] of Object.entries(CARRIERS)) {
        if (carrier.blPrefixes.includes(prefix)) {
            return {
                id: carrierId,
                name: carrier.name,
                detectedFrom: 'container_prefix',
                prefix: prefix
            }
        }
    }

    return null
}

/**
 * Detect carrier from all available information
 * @param {Object} extractedData - Data from BL extraction
 * @returns {Object|null} - Carrier info with tracking URL
 */
function detectCarrier(extractedData) {
    const { blNumber, carrier: carrierName, containerNumber } = extractedData || {}

    // Try detection in order of reliability
    let detected = null

    // 1. Try BL number prefix (most reliable)
    if (blNumber) {
        detected = detectCarrierFromBL(blNumber)
    }

    // 2. Try carrier name from extraction
    if (!detected && carrierName) {
        detected = detectCarrierFromName(carrierName)
    }

    // 3. Try container number prefix
    if (!detected && containerNumber) {
        detected = detectCarrierFromContainer(containerNumber)
    }

    if (!detected) return null

    // Add tracking URL and carrier color
    const carrierInfo = CARRIERS[detected.id]
    return {
        ...detected,
        trackingUrl: carrierInfo.trackingUrl(blNumber || containerNumber || ''),
        color: carrierInfo.color
    }
}

/**
 * Get tracking URL for a carrier
 * @param {string} carrierId - Carrier ID
 * @param {string} trackingNumber - BL or container number
 * @returns {string|null} - Tracking URL or null
 */
function getTrackingUrl(carrierId, trackingNumber) {
    const carrier = CARRIERS[carrierId]
    if (!carrier || !trackingNumber) return null
    return carrier.trackingUrl(trackingNumber)
}

/**
 * Attempt to fetch carrier ETA via public APIs (limited availability)
 * Most carriers require authentication, so this is best-effort
 * @param {string} carrierId - Carrier ID
 * @param {string} trackingNumber - BL or container/booking number
 * @returns {Object} - { eta, source, error }
 */
async function fetchCarrierETA(carrierId, trackingNumber) {
    // Currently, most carrier APIs require authentication
    // This function can be expanded as we get access to carrier APIs

    // Maersk has a public track API that sometimes works
    if (carrierId === 'maersk' && trackingNumber) {
        try {
            // Note: This endpoint may require an API key in production
            const url = `https://api.maersk.com/track/${encodeURIComponent(trackingNumber)}`
            const res = await fetchWithTimeout(url, {
                headers: {
                    'Accept': 'application/json',
                    'Consumer-Key': 'public' // Public key for limited access
                }
            }, 10000)

            if (res.ok) {
                const data = await res.json()
                // Parse Maersk response format
                if (data.containers && data.containers[0]?.eta) {
                    return {
                        eta: data.containers[0].eta,
                        source: 'maersk_api',
                        vessel: data.containers[0]?.vesselName
                    }
                }
            }
        } catch (err) {
            console.log(`Maersk API fetch failed: ${err.message}`)
        }
    }

    // Return null if no API available or fetch failed
    return {
        eta: null,
        source: null,
        error: 'Carrier API not available - use tracking link for official ETA'
    }
}

/**
 * Get all supported carriers
 * @returns {Array} - List of carrier info
 */
function getSupportedCarriers() {
    return Object.entries(CARRIERS).map(([id, carrier]) => ({
        id,
        name: carrier.name,
        prefixes: carrier.blPrefixes
    }))
}

module.exports = {
    detectCarrier,
    detectCarrierFromBL,
    detectCarrierFromName,
    detectCarrierFromContainer,
    getTrackingUrl,
    fetchCarrierETA,
    getSupportedCarriers,
    CARRIERS
}
