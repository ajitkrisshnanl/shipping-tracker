import { useEffect, useRef, useMemo } from 'react'
import { MapContainer, TileLayer, Marker, Popup, Polyline, Circle, CircleMarker, useMap } from 'react-leaflet'
import L from 'leaflet'

// Get congestion color based on severity (white -> yellow -> orange -> red gradient)
function getCongestionColor(severity) {
    // Severity is 'high' | 'medium' | 'low' from API
    if (severity === 'high') return '#ef4444' // red
    if (severity === 'medium') return '#fb923c' // orange
    if (severity === 'low') return '#fde047' // yellow
    return '#ffffff' // white - no congestion
}

// Convert severity string to numeric value for gradient calculations
function severityToNumber(severity) {
    if (severity === 'high') return 1.0
    if (severity === 'medium') return 0.6
    if (severity === 'low') return 0.3
    return 0
}

// Calculate congestion level at a point based on proximity to congestion zones (from API)
function getCongestionAtPoint(lat, lng, bottlenecks) {
    let maxSeverity = 0
    let nearestZone = null

    for (const zone of bottlenecks) {
        const dist = haversineDistance(lat, lng, zone.lat, zone.lng)
        const zoneRadiusKm = (zone.radius || 50000) / 1000 * 1.5 // Convert meters to km, extend influence

        if (dist < zoneRadiusKm) {
            // Severity decreases with distance from zone center
            const proximity = 1 - (dist / zoneRadiusKm)
            const baseSeverity = severityToNumber(zone.severity)
            const effectiveSeverity = baseSeverity * proximity

            if (effectiveSeverity > maxSeverity) {
                maxSeverity = effectiveSeverity
                nearestZone = zone
            }
        }
    }

    return { severity: maxSeverity, zone: nearestZone }
}

// Get gradient color from severity number (0 to 1)
function getGradientColor(severityNum) {
    if (severityNum <= 0) return '#ffffff' // clean white for no congestion
    if (severityNum < 0.25) return '#ffecec'
    if (severityNum < 0.45) return '#ffcccc'
    if (severityNum < 0.65) return '#ff9999'
    if (severityNum < 0.85) return '#ff6666'
    return '#e60000' // red - high congestion
}

function selectRouteMarkers(route) {
    if (!route || route.length < 2) return []
    const primary = route.filter((point) => point.type !== 'waypoint')
    if (primary.length > 2) return primary

    const maxMarkers = 6
    const step = Math.max(1, Math.floor(route.length / (maxMarkers - 1)))
    const sampled = route.filter((_, idx) => idx % step === 0 || idx === route.length - 1)
    return sampled.map((point, idx) => ({
        ...point,
        type: idx === 0 ? 'origin' : idx === sampled.length - 1 ? 'destination' : 'waypoint'
    }))
}

// Haversine distance
function haversineDistance(lat1, lng1, lat2, lng2) {
    const R = 6371
    const dLat = (lat2 - lat1) * Math.PI / 180
    const dLng = (lng2 - lng1) * Math.PI / 180
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLng / 2) * Math.sin(dLng / 2)
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// Split route into completed and remaining
function splitRoute(route, currentLat, currentLng) {
    if (!route || route.length < 2) return { completed: [], remaining: [] }

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

// Interpolate points along a line segment for smoother congestion coloring
function interpolatePoints(start, end, numPoints = 10) {
    const points = []
    for (let i = 0; i <= numPoints; i++) {
        const t = i / numPoints
        points.push({
            lat: start.lat + (end.lat - start.lat) * t,
            lng: start.lng + (end.lng - start.lng) * t
        })
    }
    return points
}

// Create colored route segments based on congestion (using API data)
function createCongestionSegments(route, bottlenecks) {
    if (!route || route.length < 2) return []

    const segments = []

    for (let i = 0; i < route.length - 1; i++) {
        const start = route[i]
        const end = route[i + 1]

        // Interpolate points along this segment
        const interpolated = interpolatePoints(
            { lat: start.lat, lng: start.lng },
            { lat: end.lat, lng: end.lng },
            15 // More points for smoother gradient
        )

        // Create sub-segments with congestion colors
        for (let j = 0; j < interpolated.length - 1; j++) {
            const p1 = interpolated[j]
            const p2 = interpolated[j + 1]
            const midLat = (p1.lat + p2.lat) / 2
            const midLng = (p1.lng + p2.lng) / 2

            const { severity, zone } = getCongestionAtPoint(midLat, midLng, bottlenecks || [])

            segments.push({
                positions: [[p1.lat, p1.lng], [p2.lat, p2.lng]],
                color: getGradientColor(severity),
                severity,
                zone
            })
        }
    }

    return segments
}

// Pre-create vessel icons (memoized for performance)
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

// Get cached icon based on selection state
const getVesselIcon = (isSelected) => isSelected ? vesselIconSelected : vesselIconNormal

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

// Map controller component
function MapController({ selectedVessel, fullRoute }) {
    const map = useMap()

    useEffect(() => {
        if (fullRoute && fullRoute.length > 1) {
            // Fit bounds to show full route
            const bounds = fullRoute.map(p => [p.lat, p.lng])
            map.fitBounds(bounds, { padding: [50, 50], maxZoom: 5 })
        } else if (selectedVessel && selectedVessel.latitude && selectedVessel.longitude) {
            map.flyTo([selectedVessel.latitude, selectedVessel.longitude], 6, { duration: 1.5 })
        }
    }, [selectedVessel, fullRoute, map])

    return null
}

// Bottleneck zone component
function BottleneckZone({ zone }) {
    const severityColors = {
        high: { fill: 'rgba(239, 68, 68, 0.2)', stroke: '#ef4444' },
        medium: { fill: 'rgba(245, 158, 11, 0.2)', stroke: '#f59e0b' },
        low: { fill: 'rgba(34, 197, 94, 0.2)', stroke: '#22c55e' }
    }
    const colors = severityColors[zone.severity] || severityColors.low

    return (
        <Circle
            center={[zone.lat, zone.lng]}
            radius={zone.radius || 50000}
            pathOptions={{
                fillColor: colors.fill,
                fillOpacity: 0.6,
                color: colors.stroke,
                weight: 2,
                dashArray: '5, 5'
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
}

// Route waypoint marker
function RouteWaypoint({ point, index }) {
    const colors = {
        origin: '#22c55e',
        destination: '#ef4444',
        passage: '#f59e0b',
        port: '#3b82f6',
        waypoint: '#6b7280'
    }

    const color = colors[point.type] || colors.waypoint

    return (
        <CircleMarker
            center={[point.lat, point.lng]}
            radius={point.type === 'origin' || point.type === 'destination' ? 8 : 5}
            pathOptions={{
                fillColor: color,
                fillOpacity: 0.9,
                color: 'white',
                weight: 2
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
}

function Map({ vessels, selectedVessel, bottlenecks, onVesselSelect }) {
    const mapRef = useRef(null)

    // Calculate full route for selected vessel with congestion segments
    const { fullRoute, completedPath, remainingPath, routeWaypoints, congestionSegments } = useMemo(() => {
        if (!selectedVessel) return { fullRoute: null, completedPath: null, remainingPath: null, routeWaypoints: [], congestionSegments: [] }

        const hasOrigin = selectedVessel.originLat && selectedVessel.originLng
        const hasDest = selectedVessel.destLat && selectedVessel.destLng
        const hasCurrent = selectedVessel.latitude && selectedVessel.longitude

        const routeFromApi = normalizeRoute(selectedVessel.route)
        const route = routeFromApi.length >= 2
            ? routeFromApi
            : (hasOrigin && hasDest
                ? [
                    { lat: selectedVessel.originLat, lng: selectedVessel.originLng, name: selectedVessel.origin || 'Origin', type: 'origin' },
                    { lat: selectedVessel.destLat, lng: selectedVessel.destLng, name: selectedVessel.destination || 'Destination', type: 'destination' }
                ]
                : [])

        if (route.length < 2) return { fullRoute: null, completedPath: null, remainingPath: null, routeWaypoints: [], congestionSegments: [] }

        // Create congestion-colored segments for the remaining route (using API bottleneck data)
        const segments = createCongestionSegments(route, bottlenecks)

        // Split into completed and remaining based on current position
        if (hasCurrent) {
            const { completed, remaining, closestIdx } = splitRoute(route, selectedVessel.latitude, selectedVessel.longitude)

            // Filter congestion segments to only show remaining route
            const remainingRoute = route.slice(closestIdx)
            const remainingSegments = createCongestionSegments(remainingRoute, bottlenecks)

            return {
                fullRoute: route,
                completedPath: completed,
                remainingPath: remaining,
                routeWaypoints: selectRouteMarkers(route),
                congestionSegments: remainingSegments
            }
        }

        // No current position - show entire route with congestion
        return {
            fullRoute: route,
            completedPath: null,
            remainingPath: route.map(p => [p.lat, p.lng]),
            routeWaypoints: selectRouteMarkers(route),
            congestionSegments: segments
        }
    }, [selectedVessel, bottlenecks])

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
            >
                {/* Dark ocean tile layer */}
                <TileLayer
                    url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
                    attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                    noWrap={true}
                />

                {/* Map controller for animations */}
                <MapController selectedVessel={selectedVessel} fullRoute={fullRoute} />

                {/* Bottleneck zones */}
                {bottlenecks.map((zone, index) => (
                    <BottleneckZone key={zone.id || index} zone={zone} />
                ))}

                {/* Completed route (solid green line - already traveled) */}
                {completedPath && completedPath.length >= 2 && (
                    <Polyline
                        positions={completedPath}
                        pathOptions={{
                            color: '#22c55e',
                            weight: 5,
                            opacity: 0.9,
                            lineCap: 'round',
                            lineJoin: 'round'
                        }}
                    />
                )}

                {/* Remaining route with congestion heatmap (colored segments) */}
                {congestionSegments && congestionSegments.map((segment, idx) => (
                    <Polyline
                        key={`congestion-${idx}`}
                        positions={segment.positions}
                        pathOptions={{
                            color: segment.color,
                            weight: 4,
                            opacity: 0.85,
                            lineCap: 'round',
                            lineJoin: 'round'
                        }}
                    >
                        {segment.zone && (
                            <Popup>
                                <div style={{ padding: '4px 0' }}>
                                    <strong style={{ color: segment.color }}>{segment.zone.name}</strong>
                                    <br />
                                    <span style={{ fontSize: 12 }}>
                                        Delay: +{segment.zone.estimatedDelay || segment.zone.delay} min
                                    </span>
                                </div>
                            </Popup>
                        )}
                    </Polyline>
                ))}

                {/* Fallback: simple remaining route if no congestion segments */}
                {(!congestionSegments || congestionSegments.length === 0) && remainingPath && remainingPath.length >= 2 && (
                    <Polyline
                        positions={remainingPath}
                        pathOptions={{
                            color: '#ffffff',
                            weight: 3,
                            opacity: 0.7,
                            dashArray: '12, 8',
                            lineCap: 'round'
                        }}
                    />
                )}

                {/* Route waypoints (ports, passages) */}
                {routeWaypoints && routeWaypoints.map((point, index) => (
                    <RouteWaypoint key={index} point={point} index={index} />
                ))}

                {/* Vessel markers */}
                {vessels.map(vessel => {
                    if (!vessel.latitude || !vessel.longitude) return null
                    const isSelected = selectedVessel?.mmsi === vessel.mmsi

                    return (
                        <Marker
                            key={vessel.mmsi}
                            position={[vessel.latitude, vessel.longitude]}
                            icon={getVesselIcon(isSelected)}
                            eventHandlers={{
                                click: () => onVesselSelect(vessel)
                            }}
                        >
                            <Popup>
                                <div style={{ minWidth: 180, padding: '4px 0' }}>
                                    <strong style={{ fontSize: 14 }}>{vessel.name || 'Unknown'}</strong>
                                    <br />
                                    <span style={{ fontSize: 12, color: '#666' }}>
                                        MMSI: {vessel.mmsi}
                                    </span>
                                    <br />
                                    <span style={{ fontSize: 12 }}>
                                        Speed: {vessel.speed?.toFixed(1) || 0} kn |
                                        Heading: {vessel.heading || vessel.cog || 0}°
                                    </span>
                                    {vessel.destination && (
                                        <>
                                            <br />
                                            <span style={{ fontSize: 12 }}>
                                                → {vessel.destination}
                                            </span>
                                        </>
                                    )}
                                </div>
                            </Popup>
                        </Marker>
                    )
                })}
            </MapContainer>
        </div>
    )
}

export default Map
