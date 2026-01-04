import { useEffect, useRef, useMemo, memo, useCallback } from 'react'
import { MapContainer, TileLayer, Marker, Popup, Polyline, Circle, CircleMarker, useMap } from 'react-leaflet'
import L from 'leaflet'

// Haversine distance (km)
function haversineDistance(lat1, lng1, lat2, lng2) {
    const R = 6371
    const dLat = (lat2 - lat1) * Math.PI / 180
    const dLng = (lng2 - lng1) * Math.PI / 180
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLng / 2) * Math.sin(dLng / 2)
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// Convert severity string to numeric value
function severityToNumber(severity) {
    if (severity === 'high') return 1.0
    if (severity === 'medium') return 0.6
    if (severity === 'low') return 0.3
    return 0
}

// Get gradient color from severity number (0 to 1)
function getGradientColor(severityNum) {
    if (severityNum <= 0) return '#ffffff'
    if (severityNum < 0.3) return '#ffe0e0'
    if (severityNum < 0.5) return '#ffb0b0'
    if (severityNum < 0.7) return '#ff7070'
    if (severityNum < 0.9) return '#ff4040'
    return '#e60000'
}

// Calculate congestion at a point based on proximity to zones
function getCongestionAtPoint(lat, lng, bottlenecks) {
    let maxSeverity = 0
    for (const zone of bottlenecks) {
        const dist = haversineDistance(lat, lng, zone.lat, zone.lng)
        const zoneRadiusKm = (zone.radius || 50000) / 1000 * 1.5
        if (dist < zoneRadiusKm) {
            const proximity = 1 - (dist / zoneRadiusKm)
            const effectiveSeverity = severityToNumber(zone.severity) * proximity
            if (effectiveSeverity > maxSeverity) {
                maxSeverity = effectiveSeverity
            }
        }
    }
    return maxSeverity
}

// Normalize route data
function normalizeRoute(route = []) {
    if (!Array.isArray(route)) return []
    return route
        .map((p) => ({
            lat: Number(p.lat ?? p.latitude ?? p.Latitude),
            lng: Number(p.lng ?? p.lon ?? p.longitude ?? p.Longitude),
            name: p.name || p.port || 'Waypoint',
            type: p.type || 'waypoint'
        }))
        .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng))
}

// Split route at current position
function splitRoute(route, currentLat, currentLng) {
    if (!route || route.length < 2) return { completed: [], remaining: [], closestIdx: 0 }

    let closestIdx = 0
    let minDist = Infinity

    for (let i = 0; i < route.length; i++) {
        const dist = haversineDistance(currentLat, currentLng, route[i].lat, route[i].lng)
        if (dist < minDist) {
            minDist = dist
            closestIdx = i
        }
    }

    const completed = route.slice(0, closestIdx + 1).map(p => [p.lat, p.lng])
    completed.push([currentLat, currentLng])

    const remaining = [[currentLat, currentLng]]
    route.slice(closestIdx + 1).forEach(p => remaining.push([p.lat, p.lng]))

    return { completed, remaining, closestIdx }
}

// Create optimized congestion segments - groups consecutive same-color segments
function createOptimizedCongestionSegments(route, bottlenecks) {
    if (!route || route.length < 2 || !bottlenecks?.length) {
        // No bottlenecks - return single white route
        return [{
            positions: route.map(p => [p.lat, p.lng]),
            color: '#ffffff'
        }]
    }

    const segments = []
    let currentSegment = { positions: [], color: null }

    for (let i = 0; i < route.length; i++) {
        const point = route[i]
        const severity = getCongestionAtPoint(point.lat, point.lng, bottlenecks)
        const color = getGradientColor(severity)

        if (currentSegment.color === null) {
            currentSegment.color = color
            currentSegment.positions.push([point.lat, point.lng])
        } else if (currentSegment.color === color) {
            currentSegment.positions.push([point.lat, point.lng])
        } else {
            // Color changed - save current segment and start new one
            if (currentSegment.positions.length >= 2) {
                segments.push({ ...currentSegment })
            }
            // Start new segment with overlap for continuity
            const lastPos = currentSegment.positions[currentSegment.positions.length - 1]
            currentSegment = {
                positions: [lastPos, [point.lat, point.lng]],
                color: color
            }
        }
    }

    // Add final segment
    if (currentSegment.positions.length >= 2) {
        segments.push(currentSegment)
    }

    return segments.length > 0 ? segments : [{
        positions: route.map(p => [p.lat, p.lng]),
        color: '#ffffff'
    }]
}

// Select key waypoints for markers
function selectRouteMarkers(route) {
    if (!route || route.length < 2) return []
    const primary = route.filter((point) => point.type !== 'waypoint')
    if (primary.length >= 2) return primary

    const maxMarkers = 5
    const step = Math.max(1, Math.floor(route.length / (maxMarkers - 1)))
    return route
        .filter((_, idx) => idx === 0 || idx === route.length - 1 || idx % step === 0)
        .map((point, idx, arr) => ({
            ...point,
            type: idx === 0 ? 'origin' : idx === arr.length - 1 ? 'destination' : 'waypoint'
        }))
}

// Pre-created vessel icons
const vesselIconNormal = L.divIcon({
    className: 'vessel-marker',
    iconSize: [16, 16],
    iconAnchor: [8, 8],
})

const vesselIconSelected = L.divIcon({
    className: 'vessel-marker selected',
    iconSize: [20, 20],
    iconAnchor: [10, 10],
})

const getVesselIcon = (isSelected) => isSelected ? vesselIconSelected : vesselIconNormal

// Memoized Map Controller
const MapController = memo(function MapController({ selectedVessel, fullRoute }) {
    const map = useMap()
    const lastVesselRef = useRef(null)

    useEffect(() => {
        if (!map) return

        if (fullRoute && fullRoute.length > 1) {
            const bounds = fullRoute.map(p => [p.lat, p.lng])
            map.fitBounds(bounds, { padding: [50, 50], maxZoom: 6, animate: true, duration: 0.5 })
        } else if (selectedVessel?.latitude && selectedVessel?.longitude) {
            // Only fly if vessel changed
            if (lastVesselRef.current !== selectedVessel.mmsi) {
                map.flyTo([selectedVessel.latitude, selectedVessel.longitude], 6, { duration: 1 })
                lastVesselRef.current = selectedVessel.mmsi
            }
        }
    }, [selectedVessel?.mmsi, fullRoute, map])

    return null
})

// Memoized Bottleneck Zone
const BottleneckZone = memo(function BottleneckZone({ zone }) {
    const severityColors = {
        high: { fill: 'rgba(239, 68, 68, 0.15)', stroke: '#ef4444' },
        medium: { fill: 'rgba(245, 158, 11, 0.15)', stroke: '#f59e0b' },
        low: { fill: 'rgba(34, 197, 94, 0.15)', stroke: '#22c55e' }
    }
    const colors = severityColors[zone.severity] || severityColors.low

    return (
        <Circle
            center={[zone.lat, zone.lng]}
            radius={zone.radius || 50000}
            pathOptions={{
                fillColor: colors.fill,
                fillOpacity: 0.5,
                color: colors.stroke,
                weight: 1.5,
                dashArray: '4, 4'
            }}
        >
            <Popup>
                <div style={{ padding: '4px 0' }}>
                    <strong>{zone.name}</strong>
                    <br />
                    <span style={{ fontSize: 12, color: '#666' }}>
                        {zone.description || 'Congestion zone'}
                    </span>
                    <br />
                    <span style={{ fontSize: 11, color: colors.stroke, fontWeight: 500 }}>
                        Severity: {zone.severity?.toUpperCase()}
                    </span>
                </div>
            </Popup>
        </Circle>
    )
})

// Memoized Route Waypoint
const RouteWaypoint = memo(function RouteWaypoint({ point }) {
    const colors = {
        origin: '#22c55e',
        destination: '#ef4444',
        passage: '#f59e0b',
        port: '#3b82f6',
        waypoint: '#6b7280'
    }

    const color = colors[point.type] || colors.waypoint
    const isEndpoint = point.type === 'origin' || point.type === 'destination'

    return (
        <CircleMarker
            center={[point.lat, point.lng]}
            radius={isEndpoint ? 7 : 4}
            pathOptions={{
                fillColor: color,
                fillOpacity: 0.9,
                color: 'white',
                weight: isEndpoint ? 2 : 1
            }}
        >
            <Popup>
                <div style={{ padding: '2px 0' }}>
                    <strong>{point.name}</strong>
                    <br />
                    <span style={{ fontSize: 11, color: '#666', textTransform: 'capitalize' }}>
                        {point.type}
                    </span>
                </div>
            </Popup>
        </CircleMarker>
    )
})

// Memoized Vessel Marker
const VesselMarker = memo(function VesselMarker({ vessel, isSelected, onSelect }) {
    if (!vessel.latitude || !vessel.longitude) return null

    return (
        <Marker
            position={[vessel.latitude, vessel.longitude]}
            icon={getVesselIcon(isSelected)}
            eventHandlers={{ click: onSelect }}
        >
            <Popup>
                <div style={{ minWidth: 160, padding: '4px 0' }}>
                    <strong style={{ fontSize: 14 }}>{vessel.name || 'Unknown'}</strong>
                    <br />
                    <span style={{ fontSize: 12, color: '#666' }}>
                        MMSI: {vessel.mmsi}
                    </span>
                    <br />
                    <span style={{ fontSize: 12 }}>
                        Speed: {vessel.speed?.toFixed(1) || 0} kn
                    </span>
                    {vessel.destination && (
                        <>
                            <br />
                            <span style={{ fontSize: 12 }}>→ {vessel.destination}</span>
                        </>
                    )}
                </div>
            </Popup>
        </Marker>
    )
})

// Route Polylines - memoized
const RoutePolylines = memo(function RoutePolylines({ completedPath, congestionSegments, remainingPath }) {
    return (
        <>
            {/* Completed route (solid green) */}
            {completedPath && completedPath.length >= 2 && (
                <Polyline
                    positions={completedPath}
                    pathOptions={{
                        color: '#22c55e',
                        weight: 4,
                        opacity: 0.9,
                        lineCap: 'round',
                        lineJoin: 'round'
                    }}
                />
            )}

            {/* Congestion-colored route segments */}
            {congestionSegments && congestionSegments.map((segment, idx) => (
                <Polyline
                    key={`seg-${idx}-${segment.color}`}
                    positions={segment.positions}
                    pathOptions={{
                        color: segment.color,
                        weight: 3,
                        opacity: 0.85,
                        lineCap: 'round',
                        lineJoin: 'round'
                    }}
                />
            ))}

            {/* Fallback simple route */}
            {(!congestionSegments || congestionSegments.length === 0) && remainingPath && remainingPath.length >= 2 && (
                <Polyline
                    positions={remainingPath}
                    pathOptions={{
                        color: '#ffffff',
                        weight: 3,
                        opacity: 0.7,
                        dashArray: '10, 6',
                        lineCap: 'round'
                    }}
                />
            )}
        </>
    )
})

function Map({ vessels, selectedVessel, bottlenecks, onVesselSelect }) {
    const mapRef = useRef(null)

    // Stable vessel select callback
    const handleVesselSelect = useCallback((vessel) => {
        onVesselSelect(vessel)
    }, [onVesselSelect])

    // Memoized route data - only recalculate when vessel or bottlenecks change
    const routeData = useMemo(() => {
        if (!selectedVessel) {
            return { fullRoute: null, completedPath: null, remainingPath: null, routeWaypoints: [], congestionSegments: [] }
        }

        const hasOrigin = selectedVessel.originLat && selectedVessel.originLng
        const hasDest = selectedVessel.destLat && selectedVessel.destLng
        const hasCurrent = selectedVessel.latitude && selectedVessel.longitude

        // Get route from API or construct from origin/dest
        const routeFromApi = normalizeRoute(selectedVessel.route)
        const route = routeFromApi.length >= 2
            ? routeFromApi
            : (hasOrigin && hasDest
                ? [
                    { lat: selectedVessel.originLat, lng: selectedVessel.originLng, name: selectedVessel.origin || 'Origin', type: 'origin' },
                    { lat: selectedVessel.destLat, lng: selectedVessel.destLng, name: selectedVessel.destination || 'Destination', type: 'destination' }
                ]
                : [])

        if (route.length < 2) {
            return { fullRoute: null, completedPath: null, remainingPath: null, routeWaypoints: [], congestionSegments: [] }
        }

        const routeWaypoints = selectRouteMarkers(route)

        if (hasCurrent) {
            const { completed, remaining, closestIdx } = splitRoute(route, selectedVessel.latitude, selectedVessel.longitude)
            const remainingRoute = route.slice(closestIdx)
            const congestionSegments = createOptimizedCongestionSegments(remainingRoute, bottlenecks || [])

            return {
                fullRoute: route,
                completedPath: completed,
                remainingPath: remaining,
                routeWaypoints,
                congestionSegments
            }
        }

        // No current position - show entire route
        const congestionSegments = createOptimizedCongestionSegments(route, bottlenecks || [])
        return {
            fullRoute: route,
            completedPath: null,
            remainingPath: route.map(p => [p.lat, p.lng]),
            routeWaypoints,
            congestionSegments
        }
    }, [selectedVessel?.mmsi, selectedVessel?.route, selectedVessel?.latitude, selectedVessel?.longitude, bottlenecks])

    const { fullRoute, completedPath, remainingPath, routeWaypoints, congestionSegments } = routeData

    return (
        <div className="map-container">
            <MapContainer
                ref={mapRef}
                center={[20, 0]}
                zoom={2}
                minZoom={2}
                maxBounds={[[-85, -180], [85, 180]]}
                maxBoundsViscosity={1.0}
                style={{ width: '100%', height: '100%' }}
                zoomControl={true}
                scrollWheelZoom={true}
                doubleClickZoom={true}
                attributionControl={false}
                preferCanvas={true}
            >
                <TileLayer
                    url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
                    attribution='&copy; OpenStreetMap'
                    noWrap={true}
                />

                <MapController selectedVessel={selectedVessel} fullRoute={fullRoute} />

                {/* Bottleneck zones */}
                {bottlenecks?.map((zone) => (
                    <BottleneckZone key={zone.id || zone.name} zone={zone} />
                ))}

                {/* Route lines */}
                <RoutePolylines
                    completedPath={completedPath}
                    congestionSegments={congestionSegments}
                    remainingPath={remainingPath}
                />

                {/* Route waypoints */}
                {routeWaypoints?.map((point, idx) => (
                    <RouteWaypoint key={`wp-${idx}-${point.name}`} point={point} />
                ))}

                {/* Vessel markers */}
                {vessels?.map(vessel => (
                    <VesselMarker
                        key={vessel.mmsi}
                        vessel={vessel}
                        isSelected={selectedVessel?.mmsi === vessel.mmsi}
                        onSelect={() => handleVesselSelect(vessel)}
                    />
                ))}
            </MapContainer>
        </div>
    )
}

export default memo(Map)
