/**
 * Sea Route Calculator
 * Generates realistic sea routes between coordinates.
 */

const searoute = require('searoute-js')

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

function estimateArrival(route, currentLat, currentLng, speedKnots) {
    const { remaining } = splitRouteByPosition(route, currentLat, currentLng)
    const remainingDistance = calculateRouteDistance(remaining)
    const hoursRemaining = remainingDistance / (speedKnots || 12)
    const eta = new Date(Date.now() + hoursRemaining * 60 * 60 * 1000)
    return {
        eta: eta.toISOString(),
        distanceRemaining: Math.round(remainingDistance),
        hoursRemaining: Math.round(hoursRemaining)
    }
}

module.exports = {
    calculateRoute,
    splitRouteByPosition,
    calculateRouteDistance,
    estimateArrival,
    haversineDistance
}
