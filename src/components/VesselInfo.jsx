// Calendar icon
const CalendarIcon = () => (
    <svg viewBox="0 0 24 24" fill="currentColor">
        <path d="M19 4h-1V2h-2v2H8V2H6v2H5c-1.11 0-1.99.9-1.99 2L3 20c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V9h14v11zM9 11H7v2h2v-2zm4 0h-2v2h2v-2zm4 0h-2v2h2v-2zm-8 4H7v2h2v-2zm4 0h-2v2h2v-2zm4 0h-2v2h2v-2z" />
    </svg>
)

// Close icon
const CloseIcon = () => (
    <svg viewBox="0 0 24 24" fill="currentColor">
        <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
    </svg>
)

function VesselInfo({ vessel, onClose }) {
    if (!vessel) return null

    const isDelayed = vessel.delayMinutes > 0
    const etaDate = vessel.eta ? new Date(vessel.eta) : null

    // Format ETA
    const formatETA = (date) => {
        if (!date) return 'Calculating...'
        return date.toLocaleDateString('en-US', {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
            year: 'numeric'
        })
    }

    return (
        <div className="info-panel">
            <div className="info-panel-header">
                <h3 className="info-panel-title">{vessel.name || 'Unknown Vessel'}</h3>
                <button className="close-btn" onClick={onClose}>
                    <CloseIcon />
                </button>
            </div>

            <div className="info-panel-content">
                {/* Vessel Details */}
                <div className="info-section">
                    <div className="info-section-title">Vessel Details</div>
                    <div className="info-row">
                        <span className="info-label">MMSI</span>
                        <span className="info-value">{vessel.mmsi}</span>
                    </div>
                    {vessel.imo && (
                        <div className="info-row">
                            <span className="info-label">IMO</span>
                            <span className="info-value">{vessel.imo}</span>
                        </div>
                    )}
                    <div className="info-row">
                        <span className="info-label">Type</span>
                        <span className="info-value">{vessel.shipType || 'Cargo'}</span>
                    </div>
                    {vessel.flag && (
                        <div className="info-row">
                            <span className="info-label">Flag</span>
                            <span className="info-value">{vessel.flag}</span>
                        </div>
                    )}
                </div>

                {/* Current Position */}
                <div className="info-section">
                    <div className="info-section-title">Current Position</div>
                    <div className="info-row">
                        <span className="info-label">Latitude</span>
                        <span className="info-value">{vessel.latitude?.toFixed(4) || 'N/A'}</span>
                    </div>
                    <div className="info-row">
                        <span className="info-label">Longitude</span>
                        <span className="info-value">{vessel.longitude?.toFixed(4) || 'N/A'}</span>
                    </div>
                    <div className="info-row">
                        <span className="info-label">Speed</span>
                        <span className="info-value">{vessel.speed?.toFixed(1) || 0} knots</span>
                    </div>
                    <div className="info-row">
                        <span className="info-label">Heading</span>
                        <span className="info-value">{vessel.heading || vessel.cog || 0}°</span>
                    </div>
                </div>

                {/* Route */}
                <div className="info-section">
                    <div className="info-section-title">Route</div>
                    <div className="info-row">
                        <span className="info-label">Port of Loading</span>
                        <span className="info-value">{vessel.origin || 'N/A'}</span>
                    </div>
                    <div className="info-row">
                        <span className="info-label">Port of Discharge</span>
                        <span className="info-value">{vessel.destination || 'N/A'}</span>
                    </div>
                    {vessel.finalDestination && (
                        <div className="info-row">
                            <span className="info-label">Final Destination</span>
                            <span className="info-value">{vessel.finalDestination}</span>
                        </div>
                    )}
                </div>

                {/* ETA Highlight */}
                <div className="info-section">
                    <div className="info-section-title">Estimated Arrival</div>
                    <div className={`eta-highlight ${isDelayed ? 'delayed' : ''}`}>
                        <div className="eta-icon">
                            <CalendarIcon />
                        </div>
                        <div className="eta-info">
                            <div className="eta-label">
                                {isDelayed ? `Delayed by ~${vessel.delayMinutes} min` : 'On Schedule'}
                            </div>
                            <div className="eta-date">{formatETA(etaDate)}</div>
                        </div>
                    </div>
                    {vessel.distanceRemainingNm && (
                        <div className="info-row">
                            <span className="info-label">Distance Remaining</span>
                            <span className="info-value">{Math.round(vessel.distanceRemainingNm)} nm</span>
                        </div>
                    )}
                    {vessel.nextWaypoint && (
                        <div className="info-row">
                            <span className="info-label">Next Waypoint</span>
                            <span className="info-value">{vessel.nextWaypoint.name || 'En route'}</span>
                        </div>
                    )}
                </div>

                {/* Conditions */}
                {vessel.weather && (
                    <div className="info-section">
                        <div className="info-section-title">Current Conditions</div>
                        <div className="info-row">
                            <span className="info-label">Wind</span>
                            <span className="info-value">
                                {(vessel.weather.wind_speed_10m ?? 0).toFixed(1)} m/s @ {vessel.weather.wind_direction_10m || 0}°
                            </span>
                        </div>
                        <div className="info-row">
                            <span className="info-label">Wave Height</span>
                            <span className="info-value">
                                {vessel.weather.wave_height ? `${vessel.weather.wave_height.toFixed(2)} m` : 'N/A'}
                            </span>
                        </div>
                    </div>
                )}

                {/* Bottleneck Warning */}
                {vessel.bottleneckWarning && (
                    <div className="info-section">
                        <div className="alert-card warning">
                            <div className="alert-icon">
                                <svg viewBox="0 0 24 24" fill="currentColor">
                                    <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z" />
                                </svg>
                            </div>
                            <div className="alert-content">
                                <div className="alert-title">{vessel.bottleneckWarning.zone}</div>
                                <div className="alert-description">
                                    Expected delay: +{vessel.bottleneckWarning.delayMinutes} minutes
                                </div>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    )
}

export default VesselInfo
