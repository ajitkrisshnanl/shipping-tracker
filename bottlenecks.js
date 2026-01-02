/**
 * Bottleneck Detection Module
 * Contains known congestion zones and proximity checking
 */

// Known global shipping bottlenecks with severity and estimated delays
const bottleneckZones = [
    {
        id: 'suez',
        name: 'Suez Canal',
        description: 'Major trade route affected by regional security concerns. Traffic reduced 50%+ since late 2023.',
        lat: 30.0,
        lng: 32.3,
        radius: 120000, // meters
        severity: 'high',
        estimatedDelay: 180, // minutes
        vesselCount: 45,
        delayFactors: ['Security concerns', 'Rerouting traffic', 'Insurance costs']
    },
    {
        id: 'panama',
        name: 'Panama Canal',
        description: 'Severe drought has limited daily transits from 36 to 22 vessels.',
        lat: 9.1,
        lng: -79.7,
        radius: 100000,
        severity: 'high',
        estimatedDelay: 300,
        vesselCount: 32,
        delayFactors: ['Drought conditions', 'Draft restrictions', 'Booking slots limited']
    },
    {
        id: 'singapore',
        name: 'Singapore Strait',
        description: 'World\'s busiest transshipment hub with heavy congestion.',
        lat: 1.2,
        lng: 103.8,
        radius: 80000,
        severity: 'medium',
        estimatedDelay: 90,
        vesselCount: 180,
        delayFactors: ['High transshipment volume', 'Container terminal delays']
    },
    {
        id: 'malacca',
        name: 'Malacca Strait',
        description: 'One of the world\'s busiest shipping lanes connecting Indian and Pacific oceans.',
        lat: 2.5,
        lng: 100.5,
        radius: 100000,
        severity: 'medium',
        estimatedDelay: 60,
        vesselCount: 95,
        delayFactors: ['Narrow passage', 'Heavy traffic density']
    },
    {
        id: 'gibraltar',
        name: 'Strait of Gibraltar',
        description: 'Mediterranean-Atlantic gateway with cross-traffic patterns.',
        lat: 35.9,
        lng: -5.5,
        radius: 60000,
        severity: 'low',
        estimatedDelay: 20,
        vesselCount: 35,
        delayFactors: ['Cross-traffic', 'Weather conditions']
    },
    {
        id: 'cape',
        name: 'Cape of Good Hope',
        description: 'Alternative route for vessels avoiding Suez. Increased traffic due to rerouting.',
        lat: -34.3,
        lng: 18.5,
        radius: 150000,
        severity: 'medium',
        estimatedDelay: 45,
        vesselCount: 75,
        delayFactors: ['Weather patterns', 'Increased traffic from Suez diversions']
    },
    {
        id: 'hormuz',
        name: 'Strait of Hormuz',
        description: 'Critical oil tanker route. Geopolitical tensions affect transit.',
        lat: 26.5,
        lng: 56.2,
        radius: 80000,
        severity: 'high',
        estimatedDelay: 120,
        vesselCount: 60,
        delayFactors: ['Geopolitical tensions', 'Security convoys']
    },
    {
        id: 'bab-el-mandeb',
        name: 'Bab el-Mandeb',
        description: 'Red Sea entrance. Security concerns have diverted many vessels.',
        lat: 12.6,
        lng: 43.3,
        radius: 100000,
        severity: 'high',
        estimatedDelay: 240,
        vesselCount: 25,
        delayFactors: ['Security incidents', 'Insurance requirements']
    },
    {
        id: 'rotterdam',
        name: 'Port of Rotterdam',
        description: 'Europe\'s largest port with periodic congestion.',
        lat: 51.9,
        lng: 4.5,
        radius: 40000,
        severity: 'low',
        estimatedDelay: 30,
        vesselCount: 45,
        delayFactors: ['Terminal capacity', 'Weather delays']
    },
    {
        id: 'shanghai',
        name: 'Port of Shanghai',
        description: 'World\'s busiest container port.',
        lat: 31.2,
        lng: 121.8,
        radius: 50000,
        severity: 'medium',
        estimatedDelay: 60,
        vesselCount: 130,
        delayFactors: ['Volume congestion', 'Customs processing']
    },
    {
        id: 'la-lb',
        name: 'LA/Long Beach',
        description: 'Major US West Coast gateway.',
        lat: 33.75,
        lng: -118.2,
        radius: 45000,
        severity: 'low',
        estimatedDelay: 25,
        vesselCount: 50,
        delayFactors: ['Berth availability', 'Truck capacity']
    },
    {
        id: 'kolkata',
        name: 'Kolkata Port',
        description: 'Major Indian port serving Eastern India.',
        lat: 22.55,
        lng: 88.35,
        radius: 30000,
        severity: 'low',
        estimatedDelay: 15,
        vesselCount: 20,
        delayFactors: ['Tidal restrictions', 'River navigation']
    },
    {
        id: 'norfolk',
        name: 'Port of Norfolk',
        description: 'Major US East Coast container terminal.',
        lat: 36.85,
        lng: -76.3,
        radius: 30000,
        severity: 'low',
        estimatedDelay: 20,
        vesselCount: 25,
        delayFactors: ['Terminal scheduling', 'Rail connections']
    }
]

/**
 * Get all bottleneck zones
 */
function getBottlenecks() {
    return bottleneckZones.map(zone => ({
        ...zone,
        // Add real-time data placeholders (would come from congestion API in production)
        lastUpdated: new Date().toISOString(),
        trend: zone.severity === 'high' ? 'increasing' : 'stable'
    }))
}

/**
 * Calculate distance between two points using Haversine formula
 */
function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3 // Earth radius in meters
    const φ1 = lat1 * Math.PI / 180
    const φ2 = lat2 * Math.PI / 180
    const Δφ = (lat2 - lat1) * Math.PI / 180
    const Δλ = (lon2 - lon1) * Math.PI / 180

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
        Math.cos(φ1) * Math.cos(φ2) *
        Math.sin(Δλ / 2) * Math.sin(Δλ / 2)
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))

    return R * c // Distance in meters
}

/**
 * Check if a vessel is near any bottleneck zone
 * Returns warning info if within zone radius
 */
function checkBottleneckProximity(vesselLat, vesselLng) {
    if (!vesselLat || !vesselLng) return null

    for (const zone of bottleneckZones) {
        const distance = haversineDistance(vesselLat, vesselLng, zone.lat, zone.lng)

        if (distance <= zone.radius) {
            return {
                zone: zone.name,
                severity: zone.severity,
                delayMinutes: zone.estimatedDelay,
                description: zone.description,
                distance: Math.round(distance / 1000), // km
                factors: zone.delayFactors
            }
        }
    }

    return null
}

/**
 * Estimate delivery delay based on route
 * Checks if route passes through any known bottlenecks
 */
function estimateRouteDelay(originLat, originLng, destLat, destLng) {
    let totalDelay = 0
    const affectedZones = []

    // Simple check: if either origin or destination is near a bottleneck
    for (const zone of bottleneckZones) {
        const distFromOrigin = haversineDistance(originLat, originLng, zone.lat, zone.lng)
        const distFromDest = haversineDistance(destLat, destLng, zone.lat, zone.lng)

        // If route likely passes through zone (simplified)
        if (distFromOrigin <= zone.radius * 3 || distFromDest <= zone.radius * 3) {
            totalDelay += zone.estimatedDelay
            affectedZones.push({
                name: zone.name,
                delay: zone.estimatedDelay,
                severity: zone.severity
            })
        }
    }

    return {
        totalDelayMinutes: totalDelay,
        affectedZones: affectedZones
    }
}

module.exports = {
    getBottlenecks,
    checkBottleneckProximity,
    estimateRouteDelay,
    haversineDistance
}
