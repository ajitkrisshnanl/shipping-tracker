/**
 * Sea Route Calculator
 * Calculates shipping routes between ports following major shipping lanes
 */

// Major shipping waypoints (key maritime passages and ports)
const waypoints = {
    // Asia
    kolkata: { lat: 22.5726, lng: 88.3639, name: 'Kolkata' },
    singapore: { lat: 1.2897, lng: 103.8501, name: 'Singapore' },
    hongkong: { lat: 22.3193, lng: 114.1694, name: 'Hong Kong' },
    shanghai: { lat: 31.2304, lng: 121.4737, name: 'Shanghai' },
    tokyo: { lat: 35.6762, lng: 139.6503, name: 'Tokyo' },
    busan: { lat: 35.1796, lng: 129.0756, name: 'Busan' },
    mumbai: { lat: 19.0760, lng: 72.8777, name: 'Mumbai' },

    // Middle East
    dubai: { lat: 25.2048, lng: 55.2708, name: 'Dubai' },
    bahrain: { lat: 26.0667, lng: 50.5577, name: 'Bahrain' },
    jeddah: { lat: 21.4858, lng: 39.1925, name: 'Jeddah' },

    // Key Passages
    malaccaStrait: { lat: 4.2105, lng: 100.2808, name: 'Malacca Strait' },
    babElMandeb: { lat: 12.5833, lng: 43.3333, name: 'Bab el-Mandeb' },
    suezNorth: { lat: 31.2653, lng: 32.3019, name: 'Suez Canal (North)' },
    suezSouth: { lat: 29.9511, lng: 32.5503, name: 'Suez Canal (South)' },
    gibraltar: { lat: 35.9667, lng: -5.5000, name: 'Gibraltar' },
    capeOfGoodHope: { lat: -34.3568, lng: 18.4740, name: 'Cape of Good Hope' },
    panamaAtlantic: { lat: 9.3817, lng: -79.9181, name: 'Panama (Atlantic)' },
    panamaPacific: { lat: 8.9500, lng: -79.5667, name: 'Panama (Pacific)' },

    // Europe
    rotterdam: { lat: 51.9225, lng: 4.4792, name: 'Rotterdam' },
    hamburg: { lat: 53.5511, lng: 9.9937, name: 'Hamburg' },
    antwerp: { lat: 51.2194, lng: 4.4025, name: 'Antwerp' },
    felixstowe: { lat: 51.9543, lng: 1.3510, name: 'Felixstowe' },

    // Mediterranean
    algeciras: { lat: 36.1408, lng: -5.4536, name: 'Algeciras' },
    piraeus: { lat: 37.9475, lng: 23.6371, name: 'Piraeus' },
    genoa: { lat: 44.4056, lng: 8.9463, name: 'Genoa' },

    // Americas
    newyork: { lat: 40.6892, lng: -74.0445, name: 'New York' },
    norfolk: { lat: 36.8508, lng: -76.2859, name: 'Norfolk, VA' },
    savannah: { lat: 32.0809, lng: -81.0912, name: 'Savannah' },
    charleston: { lat: 32.7765, lng: -79.9311, name: 'Charleston' },
    houston: { lat: 29.7604, lng: -95.3698, name: 'Houston' },
    miami: { lat: 25.7617, lng: -80.1918, name: 'Miami' },
    losangeles: { lat: 33.7395, lng: -118.2611, name: 'Los Angeles' },

    // Africa
    capeTown: { lat: -33.9249, lng: 18.4241, name: 'Cape Town' },
    durban: { lat: -29.8587, lng: 31.0218, name: 'Durban' },
    mombasa: { lat: -4.0435, lng: 39.6682, name: 'Mombasa' }
}

// Common routes through major passages
const routeTemplates = {
    asiaToUSEast: ['malaccaStrait', 'singapore', 'babElMandeb', 'suezSouth', 'suezNorth', 'gibraltar', 'newyork'],
    asiaToUSWest: ['malaccaStrait', 'singapore', 'panamaPacific', 'panamaAtlantic', 'losangeles'],
    asiaToEurope: ['malaccaStrait', 'singapore', 'babElMandeb', 'suezSouth', 'suezNorth', 'gibraltar', 'rotterdam'],
    indiaToUSEast: ['mumbai', 'babElMandeb', 'suezSouth', 'suezNorth', 'gibraltar', 'newyork'],
    indiaToUSEastViaCape: ['mumbai', 'capeOfGoodHope', 'capeTown', 'newyork'],
    gulfToUSEast: ['babElMandeb', 'suezSouth', 'suezNorth', 'gibraltar', 'newyork'],
    europeToAsia: ['rotterdam', 'gibraltar', 'suezNorth', 'suezSouth', 'babElMandeb', 'singapore']
}

/**
 * Find the closest waypoint to a coordinate
 */
function findClosestWaypoint(lat, lng) {
    let closest = null
    let minDist = Infinity

    for (const [id, wp] of Object.entries(waypoints)) {
        const dist = haversineDistance(lat, lng, wp.lat, wp.lng)
        if (dist < minDist) {
            minDist = dist
            closest = { id, ...wp }
        }
    }
    return closest
}

/**
 * Haversine distance between two points (in km)
 */
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

/**
 * Calculate a shipping route between origin and destination
 * Returns an array of waypoints
 */
function calculateRoute(originLat, originLng, destLat, destLng, originName, destName) {
    const route = []

    // Start point
    route.push({ lat: originLat, lng: originLng, name: originName || 'Origin', type: 'origin' })

    // Determine if we need to go through Suez, Panama, or Cape
    const originInAsia = originLng > 60 && originLng < 145
    const originInIndia = originLat > 8 && originLat < 35 && originLng > 68 && originLng < 92
    const originInGulf = originLat > 15 && originLat < 32 && originLng > 45 && originLng < 60
    const destInAmericas = destLng < -30
    const destInEurope = destLat > 35 && destLng > -15 && destLng < 35
    const destInUSEast = destLng > -85 && destLng < -65 && destLat > 25 && destLat < 45
    const destInUSWest = destLng < -115 && destLat > 25 && destLat < 50
    const destInAsia = destLng > 60 && destLng < 145

    // India to US East Coast (like Kolkata to Norfolk)
    if (originInIndia && destInUSEast) {
        // Via Suez Canal route
        route.push(waypoints.babElMandeb)
        route.push(waypoints.suezSouth)
        route.push(waypoints.suezNorth)
        route.push(waypoints.gibraltar)
        // Cross Atlantic
        route.push({ lat: 38, lng: -30, name: 'Mid-Atlantic', type: 'waypoint' })
    }
    // Gulf (Bahrain) to US East
    else if (originInGulf && destInUSEast) {
        route.push({ lat: 26.0, lng: 56.0, name: 'Strait of Hormuz', type: 'waypoint' })
        route.push(waypoints.babElMandeb)
        route.push(waypoints.suezSouth)
        route.push(waypoints.suezNorth)
        route.push(waypoints.gibraltar)
        route.push({ lat: 38, lng: -30, name: 'Mid-Atlantic', type: 'waypoint' })
    }
    // Asia to US East Coast via Suez
    else if (originInAsia && destInUSEast) {
        route.push(waypoints.singapore)
        route.push(waypoints.malaccaStrait)
        route.push(waypoints.babElMandeb)
        route.push(waypoints.suezSouth)
        route.push(waypoints.suezNorth)
        route.push(waypoints.gibraltar)
        route.push({ lat: 38, lng: -30, name: 'Mid-Atlantic', type: 'waypoint' })
    }
    // Asia to US West Coast via Pacific
    else if (originInAsia && destInUSWest) {
        route.push(waypoints.shanghai)
        route.push({ lat: 35, lng: 150, name: 'North Pacific', type: 'waypoint' })
        route.push({ lat: 40, lng: -150, name: 'Eastern Pacific', type: 'waypoint' })
    }
    // Europe to Asia via Suez
    else if (destInAsia && originLng < 30) {
        route.push(waypoints.gibraltar)
        route.push(waypoints.suezNorth)
        route.push(waypoints.suezSouth)
        route.push(waypoints.babElMandeb)
        route.push(waypoints.singapore)
    }
    // Default: great circle with intermediate points
    else {
        const midLat = (originLat + destLat) / 2
        const midLng = (originLng + destLng) / 2
        route.push({ lat: midLat, lng: midLng, name: 'En Route', type: 'waypoint' })
    }

    // End point
    route.push({ lat: destLat, lng: destLng, name: destName || 'Destination', type: 'destination' })

    return route
}

/**
 * Split route into completed and remaining segments based on current position
 */
function splitRouteByPosition(route, currentLat, currentLng) {
    if (!route || route.length < 2) return { completed: [], remaining: route || [] }

    let closestIndex = 0
    let minDist = Infinity

    // Find the closest segment to current position
    for (let i = 0; i < route.length; i++) {
        const dist = haversineDistance(currentLat, currentLng, route[i].lat, route[i].lng)
        if (dist < minDist) {
            minDist = dist
            closestIndex = i
        }
    }

    // Split route
    const completed = route.slice(0, closestIndex + 1)
    completed.push({ lat: currentLat, lng: currentLng, name: 'Current Position', type: 'current' })

    const remaining = [{ lat: currentLat, lng: currentLng, name: 'Current Position', type: 'current' }]
    remaining.push(...route.slice(closestIndex + 1))

    return { completed, remaining }
}

/**
 * Calculate total distance of route in nautical miles
 */
function calculateRouteDistance(route) {
    let totalKm = 0
    for (let i = 0; i < route.length - 1; i++) {
        totalKm += haversineDistance(route[i].lat, route[i].lng, route[i + 1].lat, route[i + 1].lng)
    }
    return totalKm * 0.539957 // Convert km to nautical miles
}

/**
 * Estimate arrival time based on route, current position, and speed
 */
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
    waypoints,
    calculateRoute,
    splitRouteByPosition,
    calculateRouteDistance,
    estimateArrival,
    haversineDistance,
    findClosestWaypoint
}
