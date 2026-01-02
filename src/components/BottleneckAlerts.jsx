// Warning icon
const WarningIcon = () => (
    <svg viewBox="0 0 24 24" fill="currentColor">
        <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z" />
    </svg>
)

// Info icon
const InfoIcon = () => (
    <svg viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z" />
    </svg>
)

function BottleneckAlerts({ alerts }) {
    if (!alerts || alerts.length === 0) return null

    // Filter to show only high and medium severity
    const significantAlerts = alerts.filter(
        a => a.severity === 'high' || a.severity === 'medium'
    )

    if (significantAlerts.length === 0) return null

    return (
        <div className="alerts-panel">
            <div className="section-title">Congestion Alerts</div>
            {significantAlerts.slice(0, 3).map((alert, index) => (
                <div
                    key={alert.id || index}
                    className={`alert-card ${alert.severity === 'medium' ? 'warning' : ''}`}
                >
                    <div className="alert-icon">
                        {alert.severity === 'high' ? <WarningIcon /> : <InfoIcon />}
                    </div>
                    <div className="alert-content">
                        <div className="alert-title">{alert.name}</div>
                        <div className="alert-description">
                            {alert.description || `${alert.vesselCount || 'Multiple'} vessels affected`}
                            {alert.estimatedDelay && (
                                <> • +{alert.estimatedDelay} min delay</>
                            )}
                        </div>
                    </div>
                </div>
            ))}
        </div>
    )
}

export default BottleneckAlerts
