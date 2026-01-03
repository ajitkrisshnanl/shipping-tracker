/**
 * Vessel Service - Handles API communication via HTTP polling
 */

const DEFAULT_API_TIMEOUT_MS = 20000
const POLLING_INTERVAL_MS = 30000 // 30 seconds

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_API_TIMEOUT_MS) {
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

class VesselService {
    constructor() {
        this.listeners = new Map()
        this.pollingInterval = null
        this.isConnected = false
    }

    // Event emitter methods
    on(event, callback) {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, [])
        }
        this.listeners.get(event).push(callback)
    }

    off(event, callback) {
        if (!this.listeners.has(event)) return
        const callbacks = this.listeners.get(event)
        const index = callbacks.indexOf(callback)
        if (index > -1) callbacks.splice(index, 1)
    }

    emit(event, data) {
        if (!this.listeners.has(event)) return
        this.listeners.get(event).forEach(cb => cb(data))
    }

    // Start HTTP polling for vessel updates
    connect() {
        if (this.pollingInterval) return

        console.log('Starting vessel data polling...')
        this.poll() // Initial fetch
        this.pollingInterval = setInterval(() => this.poll(), POLLING_INTERVAL_MS)
    }

    async poll() {
        try {
            const response = await fetchWithTimeout('/api/vessels')
            if (!response.ok) throw new Error('Polling failed')
            const data = await response.json()

            if (data.vessels) {
                data.vessels.forEach(v => {
                    this.emit('vesselUpdate', this.transformVesselData(v))
                })

                // Mark as connected on successful poll
                if (!this.isConnected) {
                    this.isConnected = true
                    this.emit('connect')
                }
            }
        } catch (error) {
            console.error('Polling error:', error)
            if (this.isConnected) {
                this.isConnected = false
                this.emit('disconnect')
            }
        }
    }

    disconnect() {
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval)
            this.pollingInterval = null
        }
        this.isConnected = false
    }

    transformVesselData(raw) {
        return {
            mmsi: raw.mmsi || raw.MMSI,
            imo: raw.imo || raw.IMO,
            name: raw.name || raw.ShipName || 'Unknown',
            shipType: raw.shipType || raw.Type || 'Cargo',
            flag: raw.flag || raw.Flag,
            latitude: raw.latitude || raw.Latitude,
            longitude: raw.longitude || raw.Longitude,
            speed: raw.speed || raw.Sog || 0,
            heading: raw.heading || raw.TrueHeading,
            cog: raw.cog || raw.Cog,
            destination: raw.destination || raw.Destination,
            finalDestination: raw.finalDestination || raw.final_destination || null,
            origin: raw.origin || raw.Origin,
            originLat: raw.originLat,
            originLng: raw.originLng,
            destLat: raw.destLat,
            destLng: raw.destLng,
            eta: raw.eta || raw.ETA,
            delayMinutes: raw.delayMinutes || 0,
            bottleneckWarning: raw.bottleneckWarning || null,
            route: raw.route || null,
            distanceRemainingNm: raw.distanceRemainingNm || raw.distanceRemaining || null,
            hoursRemaining: raw.hoursRemaining || null,
            nextWaypoint: raw.nextWaypoint || null,
            weather: raw.weather || null
        }
    }

    // Subscribe to vessel updates (triggers immediate refresh)
    subscribeToVessel(mmsi) {
        // With HTTP polling, just trigger an immediate poll
        this.poll()
    }

    // Search vessels by name, MMSI, or IMO
    async searchVessels(query) {
        try {
            const response = await fetchWithTimeout(`/api/vessels/search?q=${encodeURIComponent(query)}`)
            if (!response.ok) throw new Error('Search failed')
            const data = await response.json()
            return data.vessels || []
        } catch (error) {
            console.error('Search error:', error)
            throw error
        }
    }

    // Get known bottleneck zones
    async getBottlenecks() {
        try {
            const response = await fetchWithTimeout('/api/bottlenecks')
            if (!response.ok) throw new Error('Failed to fetch bottlenecks')
            const data = await response.json()
            return data.bottlenecks || []
        } catch (error) {
            console.error('Bottleneck error:', error)
            return []
        }
    }

    async getVesselDetails(mmsi) {
        const response = await fetchWithTimeout(`/api/vessels/${encodeURIComponent(mmsi)}/details`)
        if (!response.ok) throw new Error('Failed to fetch vessel details')
        const data = await response.json()
        return this.transformVesselData(data.vessel || {})
    }

    async getNotifications(mmsi) {
        const response = await fetchWithTimeout(`/api/notifications?mmsi=${encodeURIComponent(mmsi)}`)
        if (!response.ok) throw new Error('Failed to fetch notifications')
        const data = await response.json()
        return data.subscriptions || []
    }

    async createNotification({ mmsi, email, cadenceHours }) {
        const response = await fetchWithTimeout('/api/notifications', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mmsi, email, cadenceHours })
        })
        if (!response.ok) {
            const err = await response.json().catch(() => ({}))
            throw new Error(err.error || 'Failed to create notification')
        }
        const data = await response.json()
        return data.subscription
    }

    async cancelNotification(id) {
        const response = await fetchWithTimeout(`/api/notifications/${encodeURIComponent(id)}/cancel`, {
            method: 'POST'
        })
        if (!response.ok) {
            const err = await response.json().catch(() => ({}))
            throw new Error(err.error || 'Failed to cancel notification')
        }
        const data = await response.json()
        return data.subscription
    }

    async sendNotificationNow(id) {
        const response = await fetchWithTimeout(`/api/notifications/${encodeURIComponent(id)}/test`, {
            method: 'POST'
        })
        if (!response.ok) {
            const err = await response.json().catch(() => ({}))
            throw new Error(err.error || 'Failed to send test email')
        }
        const data = await response.json()
        return data.subscription
    }
}

export const vesselService = new VesselService()
