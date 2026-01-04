/**
 * Sea Route Calculator
 * Generates realistic sea routes between coordinates.
 */

const searoute = require('searoute-js')
const { calculateRouteBottleneckDelay } = require('./bottlenecks')

// Vessel type average speeds in knots (for ETA estimation when live speed unavailable)
const VESSEL_TYPE_SPEEDS = {
    'container': 18,      // Container ships
    'cargo': 14,          // General cargo
    'bulk': 13,           // Bulk carriers
    'tanker': 13,         // Oil tankers
    'lng': 17,            // LNG carriers
    'ro-ro': 16,          // Roll-on/roll-off
    'passenger': 20,      // Cruise/passenger
    'fishing': 10,        // Fishing vessels
    'tug': 12,            // Tugs
    'default': 12         // Fallback
}

// Get estimated speed based on vessel type
function getVesselTypeSpeed(vesselType) {
    if (!vesselType) return VESSEL_TYPE_SPEEDS.default
    const type = vesselType.toLowerCase()
    for (const [key, speed] of Object.entries(VESSEL_TYPE_SPEEDS)) {
        if (type.includes(key)) return speed
    }
    return VESSEL_TYPE_SPEEDS.default
}

// Adjust speed based on weather conditions
function adjustSpeedForWeather(baseSpeed, weather) {
    if (!weather) return baseSpeed
    let factor = 1.0

    // Wind impact (reduces speed in strong headwinds)
    if (weather.wind_speed_10m && weather.wind_speed_10m >= 15) {
        factor -= 0.05 * Math.min((weather.wind_speed_10m - 15) / 10, 0.3)
    }

    // Wave height impact
    if (weather.wave_height && weather.wave_height >= 2) {
        factor -= 0.03 * Math.min((weather.wave_height - 2) / 2, 0.2)
    }

    return Math.max(baseSpeed * factor, baseSpeed * 0.5) // Never below 50%
}

function haversineDistance(lat1, lng1, lat2, lng2) {
    const R = 6371 // Earth radius in km
    const dLat = (lat2 - lat1) * Math.PI / 180
    const dLng = (lng2 - lng1) * Math.PI / 180
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLng / 2) * Math.sin(dLng / 2)
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
    return R * c
}

function downsampleCoordinates(coords, maxPoints = 90) {
    if (!Array.isArray(coords) || coords.length <= maxPoints) return coords || []
    const step = Math.ceil(coords.length / maxPoints)
    return coords.filter((_, idx) => idx % step === 0 || idx === coords.length - 1)
}

function buildSeaRouteCoordinates(originLat, originLng, destLat, destLng) {
    const origin = {
        type: 'Feature',
        properties: {},
        geometry: {
            type: 'Point',
            coordinates: [Number(originLng), Number(originLat)]
        }
    }
    const destination = {
        type: 'Feature',
        properties: {},
        geometry: {
            type: 'Point',
            coordinates: [Number(destLng), Number(destLat)]
        }
    }

    try {
        const originalLog = console.log
        console.log = () => {}
        let route = null
        try {
            route = searoute(origin, destination)
        } finally {
            console.log = originalLog
        }
        const coords = route?.geometry?.coordinates
        if (!Array.isArray(coords) || coords.length < 2) return null
        return coords
    } catch (err) {
        console.error('Sea route calc failed:', err.message)
        return null
    }
}

function calculateRoute(originLat, originLng, destLat, destLng, originName, destName) {
    const coords = buildSeaRouteCoordinates(originLat, originLng, destLat, destLng)
    const points = downsampleCoordinates(coords || [], 80)

    const route = []
    const start = [Number(originLng), Number(originLat)]
    const end = [Number(destLng), Number(destLat)]

    if (points.length < 2) {
        route.push({ lat: originLat, lng: originLng, name: originName || 'Origin', type: 'origin' })
        route.push({ lat: destLat, lng: destLng, name: destName || 'Destination', type: 'destination' })
        return route
    }

    points[0] = start
    points[points.length - 1] = end

    points.forEach((coord, index) => {
        const lat = Number(coord[1])
        const lng = Number(coord[0])
        const isStart = index === 0
        const isEnd = index === points.length - 1
        route.push({
            lat,
            lng,
            name: isStart ? (originName || 'Origin') : isEnd ? (destName || 'Destination') : `Waypoint ${index}`,
            type: isStart ? 'origin' : isEnd ? 'destination' : 'waypoint'
        })
    })

    return route
}

function splitRouteByPosition(route, currentLat, currentLng) {
    if (!route || route.length < 2) return { completed: [], remaining: route || [] }

    let closestIndex = 0
    let minDist = Infinity

    for (let i = 0; i < route.length; i++) {
        const dist = haversineDistance(currentLat, currentLng, route[i].lat, route[i].lng)
        if (dist < minDist) {
            minDist = dist
            closestIndex = i
        }
    }

    const completed = route.slice(0, closestIndex + 1)
    completed.push({ lat: currentLat, lng: currentLng, name: 'Current Position', type: 'current' })

    const remaining = [{ lat: currentLat, lng: currentLng, name: 'Current Position', type: 'current' }]
    remaining.push(...route.slice(closestIndex + 1))

    return { completed, remaining }
}

function calculateRouteDistance(route) {
    let totalKm = 0
    for (let i = 0; i < route.length - 1; i++) {
        totalKm += haversineDistance(route[i].lat, route[i].lng, route[i + 1].lat, route[i + 1].lng)
    }
    return totalKm * 0.539957 // Convert km to nautical miles
}

function estimateArrival(route, currentLat, currentLng, speedKnots, options = {}) {
    const { remaining } = splitRouteByPosition(route, currentLat, currentLng)
    const remainingDistance = calculateRouteDistance(remaining)

    // Use provided speed, or estimate from vessel type, or default
    let effectiveSpeed = speedKnots
    if (!effectiveSpeed || effectiveSpeed <= 0) {
        effectiveSpeed = options.vesselType
            ? getVesselTypeSpeed(options.vesselType)
            : VESSEL_TYPE_SPEEDS.default
    }

    // Adjust for weather if available
    if (options.weather) {
        effectiveSpeed = adjustSpeedForWeather(effectiveSpeed, options.weather)
    }

    // Base travel time
    let hoursRemaining = remainingDistance / effectiveSpeed

    // Calculate bottleneck delays along the remaining route
    let bottleneckDelayMinutes = 0
    let bottlenecksPassed = []

    if (options.bottlenecks && options.bottlenecks.length > 0) {
        const delayResult = calculateRouteBottleneckDelay(remaining, options.bottlenecks)
        bottleneckDelayMinutes = delayResult.totalDelayMinutes
        bottlenecksPassed = delayResult.delays

        // Add bottleneck delays to total time
        hoursRemaining += bottleneckDelayMinutes / 60
    }

    const eta = new Date(Date.now() + hoursRemaining * 60 * 60 * 1000)

    return {
        eta: eta.toISOString(),
        distanceRemaining: Math.round(remainingDistance),
        hoursRemaining: Math.round(hoursRemaining),
        effectiveSpeed: Math.round(effectiveSpeed * 10) / 10,
        bottleneckDelayMinutes: Math.round(bottleneckDelayMinutes),
        bottlenecksPassed
    }
}

module.exports = {
    calculateRoute,
    splitRouteByPosition,
    calculateRouteDistance,
    estimateArrival,
    haversineDistance,
    getVesselTypeSpeed,
    adjustSpeedForWeather,
    VESSEL_TYPE_SPEEDS
}
