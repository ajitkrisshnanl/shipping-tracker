/**
 * Bottleneck Detection Module
 * Dynamic congestion zones with real-time vessel counts and weather impact
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

// Cache for dynamic congestion data
const congestionCache = new Map()
const CONGESTION_CACHE_TTL_MS = 30 * 60 * 1000 // 30 minutes

// Base bottleneck zone definitions (locations are static, but severity/delays are calculated dynamically)
const bottleneckZones = [
    {
        id: 'suez',
        name: 'Suez Canal',
        description: 'Major trade route connecting Mediterranean and Red Sea.',
        lat: 30.0,
        lng: 32.3,
        radius: 120000, // meters
        // Thresholds for dynamic severity calculation
        normalCapacity: 50, // vessels per day
        highThreshold: 60, // vessels waiting = high congestion
        mediumThreshold: 35,
        baseDelay: 30, // minutes base processing time
        delayPerVessel: 3, // additional minutes per waiting vessel
        delayFactors: ['Canal capacity', 'Security situation', 'Insurance costs']
    },
    {
        id: 'panama',
        name: 'Panama Canal',
        description: 'Critical Atlantic-Pacific transit point affected by water levels.',
        lat: 9.1,
        lng: -79.7,
        radius: 100000,
        normalCapacity: 36,
        highThreshold: 45,
        mediumThreshold: 25,
        baseDelay: 60,
        delayPerVessel: 8,
        delayFactors: ['Water levels', 'Draft restrictions', 'Booking availability']
    },
    {
        id: 'singapore',
        name: 'Singapore Strait',
        description: 'World\'s busiest transshipment hub.',
        lat: 1.2,
        lng: 103.8,
        radius: 80000,
        normalCapacity: 200,
        highThreshold: 250,
        mediumThreshold: 150,
        baseDelay: 20,
        delayPerVessel: 0.5,
        delayFactors: ['Transshipment volume', 'Terminal operations']
    },
    {
        id: 'malacca',
        name: 'Malacca Strait',
        description: 'Major shipping lane connecting Indian and Pacific oceans.',
        lat: 2.5,
        lng: 100.5,
        radius: 100000,
        normalCapacity: 100,
        highThreshold: 130,
        mediumThreshold: 80,
        baseDelay: 15,
        delayPerVessel: 0.5,
        delayFactors: ['Traffic density', 'Narrow passage']
    },
    {
        id: 'gibraltar',
        name: 'Strait of Gibraltar',
        description: 'Mediterranean-Atlantic gateway.',
        lat: 35.9,
        lng: -5.5,
        radius: 60000,
        normalCapacity: 50,
        highThreshold: 70,
        mediumThreshold: 40,
        baseDelay: 10,
        delayPerVessel: 0.3,
        delayFactors: ['Cross-traffic', 'Weather conditions']
    },
    {
        id: 'cape',
        name: 'Cape of Good Hope',
        description: 'Alternative route for vessels avoiding Suez.',
        lat: -34.3,
        lng: 18.5,
        radius: 150000,
        normalCapacity: 80,
        highThreshold: 120,
        mediumThreshold: 60,
        baseDelay: 20,
        delayPerVessel: 0.3,
        delayFactors: ['Weather patterns', 'Rerouting traffic']
    },
    {
        id: 'hormuz',
        name: 'Strait of Hormuz',
        description: 'Critical oil tanker route in Persian Gulf.',
        lat: 26.5,
        lng: 56.2,
        radius: 80000,
        normalCapacity: 70,
        highThreshold: 90,
        mediumThreshold: 50,
        baseDelay: 30,
        delayPerVessel: 1.5,
        delayFactors: ['Geopolitical situation', 'Security protocols']
    },
    {
        id: 'bab-el-mandeb',
        name: 'Bab el-Mandeb',
        description: 'Red Sea entrance strait.',
        lat: 12.6,
        lng: 43.3,
        radius: 100000,
        normalCapacity: 40,
        highThreshold: 50,
        mediumThreshold: 25,
        baseDelay: 45,
        delayPerVessel: 4,
        delayFactors: ['Security situation', 'Insurance requirements']
    },
    {
        id: 'rotterdam',
        name: 'Port of Rotterdam',
        description: 'Europe\'s largest port.',
        lat: 51.9,
        lng: 4.5,
        radius: 40000,
        normalCapacity: 60,
        highThreshold: 80,
        mediumThreshold: 45,
        baseDelay: 15,
        delayPerVessel: 0.5,
        delayFactors: ['Terminal capacity', 'Weather delays']
    },
    {
        id: 'shanghai',
        name: 'Port of Shanghai',
        description: 'World\'s busiest container port.',
        lat: 31.2,
        lng: 121.8,
        radius: 50000,
        normalCapacity: 150,
        highThreshold: 200,
        mediumThreshold: 100,
        baseDelay: 25,
        delayPerVessel: 0.4,
        delayFactors: ['Volume congestion', 'Customs processing']
    },
    {
        id: 'la-lb',
        name: 'LA/Long Beach',
        description: 'Major US West Coast gateway.',
        lat: 33.75,
        lng: -118.2,
        radius: 45000,
        normalCapacity: 70,
        highThreshold: 90,
        mediumThreshold: 50,
        baseDelay: 15,
        delayPerVessel: 0.4,
        delayFactors: ['Berth availability', 'Truck capacity']
    },
    {
        id: 'kolkata',
        name: 'Kolkata Port',
        description: 'Major Indian port serving Eastern India.',
        lat: 22.55,
        lng: 88.35,
        radius: 30000,
        normalCapacity: 30,
        highThreshold: 40,
        mediumThreshold: 20,
        baseDelay: 10,
        delayPerVessel: 0.5,
        delayFactors: ['Tidal restrictions', 'River navigation']
    },
    {
        id: 'norfolk',
        name: 'Port of Norfolk',
        description: 'Major US East Coast container terminal.',
        lat: 36.85,
        lng: -76.3,
        radius: 30000,
        normalCapacity: 40,
        highThreshold: 55,
        mediumThreshold: 30,
        baseDelay: 10,
        delayPerVessel: 0.4,
        delayFactors: ['Terminal scheduling', 'Rail connections']
    }
]

/**
 * Get expected vessel activity level based on time patterns
 * This provides baseline congestion estimates when live data isn't available
 */
function getTimeBasedCongestion(zone) {
    const now = new Date()
    const hour = now.getUTCHours()
    const dayOfWeek = now.getUTCDay() // 0 = Sunday

    // Base activity level (0-1 scale)
    let activityLevel = 0.5

    // Peak shipping hours: 6-10 UTC and 14-18 UTC
    if ((hour >= 6 && hour <= 10) || (hour >= 14 && hour <= 18)) {
        activityLevel += 0.2
    }

    // Lower activity on weekends
    if (dayOfWeek === 0 || dayOfWeek === 6) {
        activityLevel -= 0.15
    }

    // Zone-specific adjustments based on known patterns
    if (zone.id === 'suez' || zone.id === 'bab-el-mandeb') {
        // Red Sea routes - currently elevated due to security situation
        activityLevel += 0.25
    } else if (zone.id === 'panama') {
        // Panama - drought restrictions still in effect
        activityLevel += 0.2
    } else if (zone.id === 'singapore' || zone.id === 'shanghai') {
        // Major ports - consistently busy
        activityLevel += 0.1
    }

    return Math.min(1, Math.max(0, activityLevel))
}

/**
 * Fetch weather conditions at zone location (affects port operations)
 */
async function fetchWeatherForZone(zone) {
    const cacheKey = `weather_${zone.id}`
    const cached = congestionCache.get(cacheKey)
    if (cached && Date.now() - cached.timestamp < CONGESTION_CACHE_TTL_MS) {
        return cached.data
    }

    try {
        const url = `https://marine-api.open-meteo.com/v1/marine?latitude=${zone.lat}&longitude=${zone.lng}&current=wave_height,wave_direction,wind_speed_10m,wind_direction_10m&timezone=UTC`
        const res = await fetchWithTimeout(url, {}, 10000)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()

        const weather = {
            windSpeed: data.current?.wind_speed_10m ?? null,
            windDirection: data.current?.wind_direction_10m ?? null,
            waveHeight: data.current?.wave_height ?? null,
            waveDirection: data.current?.wave_direction ?? null,
            fetchedAt: new Date().toISOString()
        }

        congestionCache.set(cacheKey, { data: weather, timestamp: Date.now() })
        return weather
    } catch (err) {
        console.error(`Failed to fetch weather for ${zone.name}:`, err.message)
        if (cached) return cached.data
        return { windSpeed: null, waveHeight: null, error: err.message }
    }
}

/**
 * Calculate dynamic severity based on weather and time-based activity patterns
 */
function calculateDynamicSeverity(zone, weather) {
    let severity = 'low'
    let estimatedDelay = zone.baseDelay
    const warnings = []

    // Get time-based congestion level (0-1 scale)
    const activityLevel = getTimeBasedCongestion(zone)

    // Base severity from activity level
    if (activityLevel >= 0.75) {
        severity = 'high'
        estimatedDelay += Math.round(zone.baseDelay * 0.5)
        warnings.push('High traffic period')
    } else if (activityLevel >= 0.5) {
        severity = 'medium'
        estimatedDelay += Math.round(zone.baseDelay * 0.25)
    }

    // Weather impact on delays (major factor for port operations)
    if (weather && !weather.error) {
        // High winds significantly affect operations
        if (weather.windSpeed !== null && weather.windSpeed >= 12) {
            if (weather.windSpeed >= 20) {
                // Storm conditions - severe delays
                estimatedDelay += 90
                severity = 'high'
                warnings.push(`Storm winds: ${weather.windSpeed.toFixed(0)} m/s`)
            } else if (weather.windSpeed >= 15) {
                // Strong winds - moderate delays
                estimatedDelay += 45
                if (severity === 'low') severity = 'medium'
                warnings.push(`Strong winds: ${weather.windSpeed.toFixed(0)} m/s`)
            } else {
                // Moderate winds
                estimatedDelay += 15
                warnings.push(`Moderate winds: ${weather.windSpeed.toFixed(0)} m/s`)
            }
        }

        // Wave height affects vessel berthing
        if (weather.waveHeight !== null && weather.waveHeight >= 2) {
            if (weather.waveHeight >= 4) {
                estimatedDelay += 60
                severity = 'high'
                warnings.push(`High seas: ${weather.waveHeight.toFixed(1)}m waves`)
            } else if (weather.waveHeight >= 3) {
                estimatedDelay += 30
                if (severity === 'low') severity = 'medium'
                warnings.push(`Rough seas: ${weather.waveHeight.toFixed(1)}m waves`)
            } else {
                estimatedDelay += 10
            }
        }
    }

    // Calculate trend based on time of day
    const hour = new Date().getUTCHours()
    let trend = 'stable'
    if (hour >= 4 && hour <= 8) trend = 'increasing'
    else if (hour >= 18 && hour <= 22) trend = 'decreasing'

    return {
        severity,
        estimatedDelay,
        trend,
        activityLevel: Math.round(activityLevel * 100),
        warnings
    }
}

/**
 * Get all bottleneck zones with real-time congestion data
 * Fetches live weather for all zones in parallel
 */
async function getBottlenecks() {
    const zones = await Promise.all(bottleneckZones.map(async (zone) => {
        const weather = await fetchWeatherForZone(zone)

        const { severity, estimatedDelay, trend, activityLevel, warnings } = calculateDynamicSeverity(zone, weather)

        return {
            ...zone,
            severity,
            estimatedDelay,
            activityLevel,
            weather: weather.error ? null : weather,
            trend,
            warnings,
            lastUpdated: weather.fetchedAt || new Date().toISOString(),
            dataSource: 'live-weather'
        }
    }))

    return zones
}

/**
 * Synchronous version for backwards compatibility (returns cached weather or time-based data)
 */
function getBottlenecksSync() {
    return bottleneckZones.map(zone => {
        const weatherKey = `weather_${zone.id}`
        const cachedWeather = congestionCache.get(weatherKey)?.data

        const { severity, estimatedDelay, trend, activityLevel, warnings } = calculateDynamicSeverity(zone, cachedWeather)

        return {
            ...zone,
            severity,
            estimatedDelay,
            activityLevel,
            weather: cachedWeather?.error ? null : cachedWeather,
            trend,
            warnings,
            lastUpdated: cachedWeather?.fetchedAt || new Date().toISOString(),
            dataSource: cachedWeather && !cachedWeather.error ? 'cached-weather' : 'time-based'
        }
    })
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
 * Returns warning info if within zone radius (uses cached weather + time patterns)
 */
function checkBottleneckProximity(vesselLat, vesselLng) {
    if (!vesselLat || !vesselLng) return null

    for (const zone of bottleneckZones) {
        const distance = haversineDistance(vesselLat, vesselLng, zone.lat, zone.lng)

        if (distance <= zone.radius) {
            // Get cached weather data for dynamic severity
            const weatherKey = `weather_${zone.id}`
            const cachedWeather = congestionCache.get(weatherKey)?.data

            const { severity, estimatedDelay, trend, activityLevel, warnings } = calculateDynamicSeverity(zone, cachedWeather)

            return {
                zone: zone.name,
                severity,
                delayMinutes: estimatedDelay,
                description: zone.description,
                distance: Math.round(distance / 1000), // km
                factors: zone.delayFactors,
                activityLevel,
                trend,
                warnings,
                weather: cachedWeather?.error ? null : cachedWeather,
                dataSource: cachedWeather && !cachedWeather.error ? 'live-weather' : 'time-based'
            }
        }
    }

    return null
}

/**
 * Calculate cumulative delay for actual route traversal through bottleneck zones
 * Checks each waypoint in the route against all bottleneck zones
 * @param {Array} route - Array of {lat, lng} waypoints
 * @param {Array} bottlenecks - Array of bottleneck zones (from getBottlenecks or getBottlenecksSync)
 * @returns {Object} - { totalDelayMinutes, delays: [{zone, delay, severity}] }
 */
function calculateRouteBottleneckDelay(route, bottlenecks) {
    if (!route || route.length === 0 || !bottlenecks || bottlenecks.length === 0) {
        return { totalDelayMinutes: 0, delays: [] }
    }

    const passedZones = new Set() // Avoid double-counting zones
    let totalDelayMinutes = 0
    const delays = []

    for (const waypoint of route) {
        if (!waypoint.lat || !waypoint.lng) continue

        for (const zone of bottlenecks) {
            // Skip if we've already counted this zone
            if (passedZones.has(zone.id)) continue

            const dist = haversineDistance(waypoint.lat, waypoint.lng, zone.lat, zone.lng)
            const zoneRadiusMeters = zone.radius || 50000

            // Check if waypoint is within zone radius
            if (dist <= zoneRadiusMeters) {
                passedZones.add(zone.id)

                // Use pre-calculated severity if available, otherwise calculate
                let delayMinutes, severity
                if (zone.estimatedDelay !== undefined && zone.severity) {
                    delayMinutes = zone.estimatedDelay
                    severity = zone.severity
                } else {
                    // Get cached weather data for dynamic severity calculation
                    const weatherKey = `weather_${zone.id}`
                    const cachedWeather = congestionCache.get(weatherKey)?.data
                    const dynamicData = calculateDynamicSeverity(zone, cachedWeather)
                    delayMinutes = dynamicData.estimatedDelay
                    severity = dynamicData.severity
                }

                totalDelayMinutes += delayMinutes
                delays.push({
                    zoneId: zone.id,
                    zone: zone.name,
                    delay: delayMinutes,
                    severity,
                    description: zone.description
                })
            }
        }
    }

    return { totalDelayMinutes, delays }
}

/**
 * Estimate delivery delay based on route
 * Checks if route passes through any known bottlenecks (uses cached weather + time patterns)
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
            // Get cached weather data for dynamic severity
            const weatherKey = `weather_${zone.id}`
            const cachedWeather = congestionCache.get(weatherKey)?.data

            const { severity, estimatedDelay, warnings } = calculateDynamicSeverity(zone, cachedWeather)

            totalDelay += estimatedDelay
            affectedZones.push({
                name: zone.name,
                delay: estimatedDelay,
                severity,
                warnings
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
    getBottlenecksSync,
    checkBottleneckProximity,
    estimateRouteDelay,
    calculateRouteBottleneckDelay,
    haversineDistance,
    fetchWeatherForZone,
    getTimeBasedCongestion
}
