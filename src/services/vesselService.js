/**
 * Vessel Service - Handles API communication and WebSocket connections
 */

class VesselService {
    constructor() {
        this.ws = null
        this.listeners = new Map()
        this.reconnectTimeout = null
        this.isConnecting = false
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

    // Connect to WebSocket with HTTP polling fallback
    connect() {
        if (this.isConnecting) return

        this.isConnecting = true
        const isVercel = window.location.hostname.includes('vercel.app')
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
        const wsUrl = `${protocol}//${window.location.host}/ws`

        // Start HTTP Polling as a reliable backup/primary for Vercel
        this.startPolling()

        // Only try WebSocket if not on Vercel (or try anyway but don't rely on it)
        try {
            this.ws = new WebSocket(wsUrl)

            this.ws.onopen = () => {
                console.log('WebSocket connected')
                this.isConnecting = false
                this.emit('connect')
                // Stop polling if WS is successful (optional, but keep it for robust Vercel support)
            }

            this.ws.onclose = () => {
                console.log('WebSocket disconnected')
                this.isConnecting = false
                this.emit('disconnect')
                // Reconnect WS after delay
                this.reconnectTimeout = setTimeout(() => this.connect(), 5000)
            }

            this.ws.onerror = (error) => {
                console.error('WebSocket error:', error)
                this.isConnecting = false
            }

            this.ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data)
                    this.handleMessage(data)
                } catch (e) {
                    console.error('Failed to parse message:', e)
                }
            }
        } catch (error) {
            console.error('Failed to connect WebSocket:', error)
            this.isConnecting = false
        }
    }

    startPolling() {
        if (this.pollingInterval) return

        console.log('Starting HTTP polling fallback...')
        this.poll()
        this.pollingInterval = setInterval(() => this.poll(), 30000) // 30s to match Render idle behavior
    }

    async poll() {
        try {
            const response = await fetch('/api/vessels')
            if (!response.ok) throw new Error('Polling failed')
            const data = await response.json()

            if (data.vessels) {
                data.vessels.forEach(v => {
                    this.emit('vesselUpdate', this.transformVesselData(v))
                })
                // If polling works, we are "connected" in a sense
                this.emit('connect')
            }
        } catch (error) {
            console.error('Polling error:', error)
        }
    }

    disconnect() {
        if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout)
        if (this.pollingInterval) clearInterval(this.pollingInterval)
        if (this.ws) {
            this.ws.close()
            this.ws = null
        }
    }

    handleMessage(data) {
        if (data.type === 'position') {
            this.emit('vesselUpdate', this.transformVesselData(data.vessel))
        } else if (data.type === 'vessels') {
            data.vessels.forEach(v => {
                this.emit('vesselUpdate', this.transformVesselData(v))
            })
        }
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

    // Subscribe to vessel updates
    subscribeToVessel(mmsi) {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
                type: 'subscribe',
                mmsi: mmsi
            }))
        }
    }

    // Search vessels by name, MMSI, or IMO
    async searchVessels(query) {
        try {
            const response = await fetch(`/api/vessels/search?q=${encodeURIComponent(query)}`)
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
            const response = await fetch('/api/bottlenecks')
            if (!response.ok) throw new Error('Failed to fetch bottlenecks')
            const data = await response.json()
            return data.bottlenecks || []
        } catch (error) {
            console.error('Bottleneck error:', error)
            return []
        }
    }

    async getVesselDetails(mmsi) {
        const response = await fetch(`/api/vessels/${encodeURIComponent(mmsi)}/details`)
        if (!response.ok) throw new Error('Failed to fetch vessel details')
        const data = await response.json()
        return this.transformVesselData(data.vessel || {})
    }
}

export const vesselService = new VesselService()
