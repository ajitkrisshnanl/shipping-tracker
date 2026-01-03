import { useState, useEffect, useCallback } from 'react'
import Map from './components/Map'
import SearchPanel from './components/SearchPanel'
import VesselInfo from './components/VesselInfo'
import BottleneckAlerts from './components/BottleneckAlerts'
import ImportPanel from './components/ImportPanel'
import { vesselService } from './services/vesselService'

// Ship icon SVG
const ShipIcon = () => (
    <svg viewBox="0 0 24 24">
        <path d="M20 21c-1.39 0-2.78-.47-4-1.32-2.44 1.71-5.56 1.71-8 0C6.78 20.53 5.39 21 4 21H2v2h2c1.38 0 2.74-.35 4-.99 2.52 1.29 5.48 1.29 8 0 1.26.64 2.62.99 4 .99h2v-2h-2zM3.95 19H4c1.6 0 3.02-.88 4-2 .98 1.12 2.4 2 4 2s3.02-.88 4-2c.98 1.12 2.4 2 4 2h.05l1.89-6.68c.08-.26.06-.54-.06-.78s-.34-.42-.6-.5L20 10.62V6c0-1.1-.9-2-2-2h-3V1H9v3H6c-1.1 0-2 .9-2 2v4.62l-1.29.42c-.26.08-.48.26-.6.5s-.14.52-.06.78L3.95 19zM6 6h12v3.97L12 8 6 9.97V6z" />
    </svg>
)

function App() {
    const [vessels, setVessels] = useState([])
    const [selectedVessel, setSelectedVessel] = useState(null)
    const [bottlenecks, setBottlenecks] = useState([])
    const [isConnected, setIsConnected] = useState(false)
    const [searchQuery, setSearchQuery] = useState('')
    const [isLoading, setIsLoading] = useState(false)
    const [showImport, setShowImport] = useState(false)

    // Initialize connection
    useEffect(() => {
        const handleConnect = () => setIsConnected(true)
        const handleDisconnect = () => setIsConnected(false)
        const handleVesselUpdate = (vesselData) => {
            setVessels(prev => {
                const index = prev.findIndex(v => v.mmsi === vesselData.mmsi)
                if (index >= 0) {
                    const updated = [...prev]
                    updated[index] = { ...updated[index], ...vesselData }
                    return updated
                }
                return [...prev, vesselData]
            })
        }

        vesselService.on('connect', handleConnect)
        vesselService.on('disconnect', handleDisconnect)
        vesselService.on('vesselUpdate', handleVesselUpdate)

        // Connect to websocket
        vesselService.connect()

        // Load bottleneck zones
        vesselService.getBottlenecks().then(setBottlenecks)

        return () => {
            vesselService.off('connect', handleConnect)
            vesselService.off('disconnect', handleDisconnect)
            vesselService.off('vesselUpdate', handleVesselUpdate)
            vesselService.disconnect()
        }
    }, [])

    const handleSearch = useCallback(async (query) => {
        if (!query.trim()) return
        setIsLoading(true)
        try {
            const results = await vesselService.searchVessels(query)
            if (results.length > 0) {
                setVessels(results)
                // Subscribe to first result for live updates
                vesselService.subscribeToVessel(results[0].mmsi)
            }
        } catch (error) {
            console.error('Search failed:', error)
        } finally {
            setIsLoading(false)
        }
    }, [])

    const handleVesselSelect = useCallback((vessel) => {
        setSelectedVessel(vessel)
        if (vessel) {
            vesselService.subscribeToVessel(vessel.mmsi)
            vesselService.getVesselDetails(vessel.mmsi)
                .then((full) => {
                    setSelectedVessel(prev => prev && prev.mmsi === full.mmsi ? { ...prev, ...full } : prev)
                    setVessels(prev => prev.map(v => v.mmsi === full.mmsi ? { ...v, ...full } : v))
                })
                .catch((err) => console.error('details load error', err))
        }
    }, [])

    const handleCloseInfo = useCallback(() => {
        setSelectedVessel(null)
    }, [])

    const handleImportComplete = useCallback((vessel) => {
        if (vessel) {
            setVessels(prev => {
                // Check if exists
                const exists = prev.some(v => v.mmsi === vessel.mmsi)
                if (exists) return prev.map(v => v.mmsi === vessel.mmsi ? { ...v, ...vessel } : v)
                return [...prev, vessel]
            })
            // Select the imported vessel
            setSelectedVessel(vessel)
            vesselService.subscribeToVessel(vessel.mmsi)
        }
        setShowImport(false)
    }, [])

    return (
        <div className="app-container">
            {/* Sidebar */}
            <aside className="sidebar">
                {/* Header */}
                <header className="header">
                    <div className="logo">
                        <div className="logo-icon">
                            <ShipIcon />
                        </div>
                        <span className="logo-text">Vessel Tracker</span>
                    </div>
                    <div className="connection-status">
                        <div className={`status-dot ${!isConnected ? 'disconnected' : ''}`}></div>
                        <span>{isConnected ? 'Live' : 'Offline'}</span>
                    </div>
                </header>

                {/* Search */}
                <SearchPanel
                    query={searchQuery}
                    onQueryChange={setSearchQuery}
                    onSearch={handleSearch}
                    isLoading={isLoading}
                />

                {/* Import Button */}
                <div style={{ padding: '0 20px 10px' }}>
                    <button
                        onClick={() => setShowImport(true)}
                        style={{
                            width: '100%',
                            padding: '10px',
                            background: 'var(--bg-tertiary)',
                            border: '1px dashed var(--border-accent)',
                            borderRadius: '8px',
                            color: 'var(--accent-primary)',
                            cursor: 'pointer',
                            fontSize: '13px',
                            fontWeight: '500',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: '8px'
                        }}
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                            <polyline points="17 8 12 3 7 8" />
                            <line x1="12" y1="3" x2="12" y2="15" />
                        </svg>
                        Import Invoice/BL
                    </button>
                </div>

                {/* Vessel List */}
                <div className="vessel-list">
                    <div className="section-title">Tracked Vessels</div>
                    {vessels.length === 0 ? (
                        <div className="empty-state">
                            <div className="empty-state-icon">
                                <ShipIcon />
                            </div>
                            <div className="empty-state-title">No vessels tracked</div>
                            <div className="empty-state-text">
                                Search for a vessel or import a BL
                            </div>
                        </div>
                    ) : (
                        vessels.map(vessel => (
                            <VesselCard
                                key={vessel.mmsi}
                                vessel={vessel}
                                isActive={selectedVessel?.mmsi === vessel.mmsi}
                                onClick={() => handleVesselSelect(vessel)}
                            />
                        ))
                    )}
                </div>

                {/* Bottleneck Alerts */}
                {bottlenecks.length > 0 && (
                    <BottleneckAlerts alerts={bottlenecks} />
                )}
            </aside>

            {/* Map */}
            <main className="main-content">
                <Map
                    vessels={vessels}
                    selectedVessel={selectedVessel}
                    bottlenecks={bottlenecks}
                    onVesselSelect={handleVesselSelect}
                />

                {/* Vessel Info Panel */}
                {selectedVessel && (
                    <VesselInfo
                        vessel={selectedVessel}
                        onClose={handleCloseInfo}
                    />
                )}

                {/* Import Modal */}
                {showImport && (
                    <ImportPanel
                        onClose={() => setShowImport(false)}
                        onImportComplete={handleImportComplete}
                    />
                )}
            </main>
        </div>
    )
}

// Vessel Card Component
function VesselCard({ vessel, isActive, onClick }) {
    const isDelayed = vessel.delayMinutes > 0

    return (
        <div
            className={`vessel-card ${isActive ? 'active' : ''}`}
            onClick={onClick}
        >
            <div className="vessel-header">
                <div className="vessel-icon">
                    <ShipIcon />
                </div>
                <div className="vessel-info">
                    <div className="vessel-name">{vessel.name || 'Unknown Vessel'}</div>
                    <div className="vessel-type">{vessel.shipType || 'Cargo'}</div>
                </div>
                <div className={`vessel-status ${isDelayed ? 'delayed' : ''}`}>
                    {isDelayed ? `+${vessel.delayMinutes}m` : 'On Time'}
                </div>
            </div>

            <div className="vessel-route">
                <div className="route-port">
                    <div className="route-port-label">Port of Loading</div>
                    <div className="route-port-name">{vessel.origin || 'N/A'}</div>
                </div>
                <span className="route-arrow">→</span>
                <div className="route-port">
                    <div className="route-port-label">Port of Discharge</div>
                    <div className="route-port-name">{vessel.destination || 'N/A'}</div>
                </div>
            </div>

            <div className="vessel-meta">
                <div className="meta-item">
                    <span className="meta-label">Speed</span>
                    <span className="meta-value">{vessel.speed?.toFixed(1) || '0'} kn</span>
                </div>
                <div className="meta-item">
                    <span className="meta-label">ETA</span>
                    <span className="meta-value">
                        {vessel.eta ? new Date(vessel.eta).toLocaleDateString() : 'N/A'}
                    </span>
                </div>
            </div>
        </div>
    )
}

export default App
