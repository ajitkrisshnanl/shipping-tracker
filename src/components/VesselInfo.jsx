import { useEffect, useRef, useState } from 'react'
import { vesselService } from '../services/vesselService'

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

// Chevron icon for expand/collapse
const ChevronIcon = ({ direction }) => (
    <svg viewBox="0 0 24 24" fill="currentColor" style={{ transform: direction === 'up' ? 'rotate(180deg)' : 'none' }}>
        <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z" />
    </svg>
)

function VesselInfo({ vessel, onClose }) {
    if (!vessel) return null

    const isDelayed = vessel.delayMinutes > 0
    const etaDate = vessel.eta ? new Date(vessel.eta) : null
    const [email, setEmail] = useState('')
    const [cadenceHours, setCadenceHours] = useState(24)
    const [subscriptions, setSubscriptions] = useState([])
    const [notificationError, setNotificationError] = useState(null)
    const [notificationSuccess, setNotificationSuccess] = useState(null)
    const [isSubmitting, setIsSubmitting] = useState(false)
    const [sendingId, setSendingId] = useState(null)
    const [carrierEta, setCarrierEta] = useState(null)
    const [carrierEtaError, setCarrierEtaError] = useState(null)
    const [carrierEtaLoading, setCarrierEtaLoading] = useState(false)
    const [isMinimized, setIsMinimized] = useState(() => {
        if (typeof window === 'undefined') return false
        return window.matchMedia('(max-width: 768px)').matches
    })
    const touchStartY = useRef(null)
    const trackingNumber = vessel?.blNumber || vessel?.bookingNumber || vessel?.containerNumber || null

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

    const formatCarrierETA = (etaValue) => {
        if (!etaValue) return 'Unavailable'
        const date = new Date(etaValue)
        if (Number.isNaN(date.getTime())) return etaValue
        return formatETA(date)
    }

    useEffect(() => {
        let active = true
        if (vessel?.mmsi) {
            vesselService.getNotifications(vessel.mmsi)
                .then((list) => {
                    if (active) setSubscriptions(list)
                })
                .catch(() => {
                    if (active) setSubscriptions([])
                })
        }
        return () => { active = false }
    }, [vessel?.mmsi])

    useEffect(() => {
        setCarrierEta(null)
        setCarrierEtaError(null)
        setCarrierEtaLoading(false)
    }, [vessel?.mmsi])

    useEffect(() => {
        if (typeof window === 'undefined') return
        const media = window.matchMedia('(max-width: 768px)')
        const handleChange = (event) => {
            if (!event.matches) {
                setIsMinimized(false)
            }
        }
        if (media.addEventListener) {
            media.addEventListener('change', handleChange)
        } else {
            media.addListener(handleChange)
        }
        return () => {
            if (media.removeEventListener) {
                media.removeEventListener('change', handleChange)
            } else {
                media.removeListener(handleChange)
            }
        }
    }, [])

    useEffect(() => {
        if (typeof window === 'undefined') return
        if (window.matchMedia('(max-width: 768px)').matches) {
            setIsMinimized(true)
        }
    }, [vessel?.mmsi])

    const handleCreateNotification = async (event) => {
        event.preventDefault()
        setNotificationError(null)
        setNotificationSuccess(null)
        if (!email || !vessel?.mmsi) return
        setIsSubmitting(true)
        try {
            const sub = await vesselService.createNotification({
                mmsi: vessel.mmsi,
                email,
                cadenceHours
            })
            setSubscriptions(prev => [...prev, sub])
            setNotificationSuccess('Email updates scheduled.')
            setEmail('')
        } catch (err) {
            setNotificationError(err.message)
        } finally {
            setIsSubmitting(false)
        }
    }

    const handleCancelNotification = async (id) => {
        setNotificationError(null)
        setNotificationSuccess(null)
        try {
            const updated = await vesselService.cancelNotification(id)
            setSubscriptions(prev => prev.map(s => s.id === updated.id ? updated : s))
            setNotificationSuccess('Email updates stopped.')
        } catch (err) {
            setNotificationError(err.message)
        }
    }

    const handleSendNow = async (id) => {
        setNotificationError(null)
        setNotificationSuccess(null)
        setSendingId(id)
        try {
            await vesselService.sendNotificationNow(id)
            setNotificationSuccess('Test email sent.')
        } catch (err) {
            setNotificationError(err.message)
        } finally {
            setSendingId(null)
        }
    }

    const handleFetchCarrierEta = async () => {
        if (!vessel?.carrierId || !trackingNumber) return
        setCarrierEtaError(null)
        setCarrierEtaLoading(true)
        try {
            const result = await vesselService.fetchCarrierETA({
                carrierId: vessel.carrierId,
                trackingNumber
            })
            if (result?.eta) {
                setCarrierEta(result)
            } else {
                setCarrierEta(null)
                setCarrierEtaError(result?.error || 'Carrier ETA not available')
            }
        } catch (err) {
            setCarrierEta(null)
            setCarrierEtaError(err.message)
        } finally {
            setCarrierEtaLoading(false)
        }
    }

    const handleHandleTouchStart = (event) => {
        touchStartY.current = event.touches?.[0]?.clientY ?? null
    }

    const handleHandleTouchEnd = (event) => {
        if (touchStartY.current === null) return
        const endY = event.changedTouches?.[0]?.clientY ?? touchStartY.current
        const delta = touchStartY.current - endY
        const threshold = 30
        if (Math.abs(delta) >= threshold) {
            setIsMinimized(delta < 0)
        }
        touchStartY.current = null
    }

    return (
        <div className={`info-panel ${isMinimized ? 'minimized' : ''}`}>
            {/* Drag handle for mobile - tap to expand/collapse */}
            <div
                className="info-panel-handle"
                onClick={() => setIsMinimized(!isMinimized)}
                onTouchStart={handleHandleTouchStart}
                onTouchEnd={handleHandleTouchEnd}
            >
                <div className="handle-bar"></div>
            </div>

            <div className="info-panel-header">
                <h3 className="info-panel-title">{vessel.name || 'Unknown Vessel'}</h3>
                <div className="header-actions">
                    {/* Minimize/Expand button for mobile */}
                    <button
                        className="minimize-btn"
                        onClick={() => setIsMinimized(!isMinimized)}
                        aria-label={isMinimized ? 'Expand' : 'Minimize'}
                    >
                        <ChevronIcon direction={isMinimized ? 'up' : 'down'} />
                    </button>
                    <button className="close-btn" onClick={onClose} aria-label="Close">
                        <CloseIcon />
                    </button>
                </div>
            </div>

            {/* Summary shown when minimized */}
            {isMinimized && (
                <div className="info-panel-summary" onClick={() => setIsMinimized(false)}>
                    <span className="summary-route">
                        {vessel.origin || 'Origin'} → {vessel.destination || 'Destination'}
                    </span>
                    <span className={`summary-status ${isDelayed ? 'delayed' : 'on-time'}`}>
                        {isDelayed ? `+${vessel.delayMinutes}m` : 'On Time'}
                    </span>
                </div>
            )}

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
                    {vessel.carrier && (
                        <div className="info-row">
                            <span className="info-label">Carrier</span>
                            <span className="info-value carrier-name" style={vessel.carrierColor ? { color: vessel.carrierColor } : {}}>
                                {vessel.carrier}
                            </span>
                        </div>
                    )}
                </div>

                {/* Carrier Tracking */}
                {(vessel.carrierTrackingUrl || vessel.carrierId) && (
                    <div className="info-section">
                        <div className="info-section-title">Carrier Tracking</div>
                        {vessel.blNumber && (
                            <div className="info-row">
                                <span className="info-label">B/L Number</span>
                                <span className="info-value mono">{vessel.blNumber}</span>
                            </div>
                        )}
                        {vessel.containerNumber && (
                            <div className="info-row">
                                <span className="info-label">Container</span>
                                <span className="info-value mono">{vessel.containerNumber}</span>
                            </div>
                        )}
                        {vessel.carrierTrackingUrl && (
                            <a
                                href={vessel.carrierTrackingUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="carrier-tracking-link"
                                style={vessel.carrierColor ? { backgroundColor: vessel.carrierColor } : {}}
                            >
                                <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
                                    <path d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/>
                                </svg>
                                Track on {vessel.carrier || 'Carrier'}
                            </a>
                        )}
                        {vessel.carrierId && trackingNumber && (
                            <div className="carrier-eta-actions">
                                <button
                                    type="button"
                                    className="secondary-btn"
                                    onClick={handleFetchCarrierEta}
                                    disabled={carrierEtaLoading}
                                >
                                    {carrierEtaLoading ? 'Checking Carrier ETA...' : 'Load Carrier ETA'}
                                </button>
                            </div>
                        )}
                        {carrierEta?.eta && (
                            <div className="info-row">
                                <span className="info-label">Carrier ETA</span>
                                <span className="info-value">{formatCarrierETA(carrierEta.eta)}</span>
                            </div>
                        )}
                        {carrierEtaError && (
                            <div className="error-message" style={{ marginTop: 8 }}>
                                {carrierEtaError}
                            </div>
                        )}
                    </div>
                )}

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
                    {vessel.hoursRemaining && (
                        <div className="info-row">
                            <span className="info-label">Travel Time</span>
                            <span className="info-value">
                                {vessel.hoursRemaining >= 24
                                    ? `${Math.floor(vessel.hoursRemaining / 24)}d ${vessel.hoursRemaining % 24}h`
                                    : `${vessel.hoursRemaining}h`
                                }
                            </span>
                        </div>
                    )}
                    {vessel.nextWaypoint && (
                        <div className="info-row">
                            <span className="info-label">Next Waypoint</span>
                            <span className="info-value">{vessel.nextWaypoint.name || 'En route'}</span>
                        </div>
                    )}
                </div>

                {/* ETA Breakdown - Bottleneck Delays */}
                {vessel.bottlenecksPassed && vessel.bottlenecksPassed.length > 0 && (
                    <div className="info-section">
                        <div className="info-section-title">Route Delays</div>
                        <div className="delay-breakdown">
                            {vessel.bottlenecksPassed.map((zone, idx) => (
                                <div key={zone.zoneId || idx} className="info-row delay-item">
                                    <span className="info-label">
                                        <span className={`severity-dot ${zone.severity}`}></span>
                                        {zone.zone}
                                    </span>
                                    <span className="info-value delay-value">
                                        +{zone.delay >= 60
                                            ? `${Math.floor(zone.delay / 60)}h ${zone.delay % 60}m`
                                            : `${zone.delay}m`
                                        }
                                    </span>
                                </div>
                            ))}
                            {vessel.bottleneckDelayMinutes > 0 && (
                                <div className="info-row total-delay">
                                    <span className="info-label">Total Delay</span>
                                    <span className="info-value delay-value">
                                        +{vessel.bottleneckDelayMinutes >= 60
                                            ? `${Math.floor(vessel.bottleneckDelayMinutes / 60)}h ${vessel.bottleneckDelayMinutes % 60}m`
                                            : `${vessel.bottleneckDelayMinutes}m`
                                        }
                                    </span>
                                </div>
                            )}
                        </div>
                    </div>
                )}

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

                {/* Email Updates */}
                <div className="info-section">
                    <div className="info-section-title">Email Updates</div>
                    <form onSubmit={handleCreateNotification} style={{ display: 'grid', gap: 8 }}>
                        <input
                            type="email"
                            className="search-input"
                            placeholder="you@example.com"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            required
                        />
                        <label className="info-row" style={{ justifyContent: 'space-between' }}>
                            <span className="info-label">Cadence (hours)</span>
                            <input
                                type="number"
                                min="1"
                                max="168"
                                value={cadenceHours}
                                onChange={(e) => setCadenceHours(Number(e.target.value))}
                                style={{
                                    width: 96,
                                    minHeight: 36,
                                    textAlign: 'right',
                                    background: 'var(--bg-tertiary)',
                                    border: '1px solid var(--border-subtle)',
                                    color: 'var(--text-primary)',
                                    borderRadius: 6,
                                    padding: '6px 8px'
                                }}
                            />
                        </label>
                        <button className="primary-btn" type="submit" disabled={isSubmitting || !email}>
                            {isSubmitting ? 'Scheduling...' : 'Start Email Updates'}
                        </button>
                    </form>
                    {notificationError && (
                        <div className="error-message" style={{ marginTop: 8 }}>{notificationError}</div>
                    )}
                    {notificationSuccess && (
                        <div className="success-message" style={{ marginTop: 8 }}>{notificationSuccess}</div>
                    )}

                    {subscriptions.filter(s => s.active).length > 0 && (
                        <div style={{ marginTop: 12, display: 'grid', gap: 6 }}>
                            {subscriptions.filter(s => s.active).map(sub => (
                                <div key={sub.id} className="info-row" style={{ alignItems: 'center' }}>
                                    <span className="info-label">{sub.email}</span>
                                    <span className="info-value">{sub.cadenceHours}h</span>
                                    <button
                                        type="button"
                                        className="secondary-btn"
                                        onClick={() => handleSendNow(sub.id)}
                                        disabled={sendingId === sub.id}
                                        style={{ marginLeft: 8 }}
                                    >
                                        {sendingId === sub.id ? 'Sending...' : 'Send Now'}
                                    </button>
                                    <button
                                        type="button"
                                        className="secondary-btn"
                                        onClick={() => handleCancelNotification(sub.id)}
                                        style={{ marginLeft: 8 }}
                                    >
                                        Stop
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    )
}

export default VesselInfo
