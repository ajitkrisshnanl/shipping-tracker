import { useState, useRef } from 'react'

function ImportPanel({ onClose, onImportComplete }) {
    const [file, setFile] = useState(null)
    const [isUploading, setIsUploading] = useState(false)
    const [extractedData, setExtractedData] = useState(null)
    const [error, setError] = useState(null)
    const fileInputRef = useRef(null)

    const handleFileChange = (e) => {
        if (e.target.files && e.target.files[0]) {
            setFile(e.target.files[0])
            setError(null)
            setExtractedData(null)
        }
    }

    const handleUpload = async () => {
        if (!file) return

        setIsUploading(true)
        setError(null)

        const formData = new FormData()
        formData.append('file', file)

        try {
            const response = await fetch('/api/import/bl', {
                method: 'POST',
                body: formData
            })

            const data = await response.json()

            if (!response.ok) {
                throw new Error(data.error || 'Upload failed')
            }

            setExtractedData(data)
        } catch (err) {
            console.error('Upload Error:', err)
            setError(err.message)
        } finally {
            setIsUploading(false)
        }
    }

    const handleConfirm = () => {
        if (onImportComplete && extractedData?.vessel) {
            onImportComplete(extractedData.vessel)
        }
        onClose()
    }

    const hasData = extractedData && extractedData.vessel

    return (
        <div className="import-overlay">
            <div className="import-panel">
                <div className="import-header">
                    <h3>Import Bill of Lading / Invoice</h3>
                    <button className="close-btn" onClick={onClose}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                </div>

                <div className="import-content">
                    {!extractedData ? (
                        <div className="upload-section">
                            <div
                                className="drop-zone"
                                onClick={() => fileInputRef.current?.click()}
                            >
                                <div className="upload-icon">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                                    </svg>
                                </div>
                                <p>Click to upload PDF or drag and drop</p>
                                <span className="file-hint">Supported formats: PDF (Bill of Lading, Invoice)</span>
                            </div>
                            <input
                                type="file"
                                ref={fileInputRef}
                                onChange={handleFileChange}
                                accept=".pdf"
                                style={{ display: 'none' }}
                            />

                            {file && (
                                <div className="selected-file">
                                    <span className="file-name">{file.name}</span>
                                    <span className="file-size">{(file.size / 1024).toFixed(1)} KB</span>
                                </div>
                            )}

                            {error && <div className="error-message">{error}</div>}

                            <button
                                className="upload-btn"
                                disabled={!file || isUploading}
                                onClick={handleUpload}
                            >
                                {isUploading ? 'Extracting Data...' : 'Upload & Extract'}
                            </button>
                        </div>
                    ) : (
                        <div className="review-section">
                            {hasData ? (
                                <>
                                    <div className="success-message">
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                                        </svg>
                                        Data Extracted Successfully
                                    </div>

                                    <div className="extracted-data-card">
                                        <div className="data-row">
                                            <span className="label">Vessel Name</span>
                                            <span className="value highlight">{extractedData.vessel.name}</span>
                                        </div>
                                        <div className="data-row">
                                            <span className="label">Voyage No</span>
                                            <span className="value">{extractedData.vessel.voyageNo || extractedData.vessel.voyage || '-'}</span>
                                        </div>
                                        <div className="data-row">
                                            <span className="label">Port of Loading</span>
                                            <span className="value">{extractedData.vessel.origin}</span>
                                        </div>
                                        <div className="data-row">
                                            <span className="label">Port of Discharge</span>
                                            <span className="value">{extractedData.vessel.destination}</span>
                                        </div>
                                        {extractedData.vessel.finalDestination && (
                                            <div className="data-row">
                                                <span className="label">Final Destination</span>
                                                <span className="value">{extractedData.vessel.finalDestination}</span>
                                            </div>
                                        )}
                                        <div className="data-row">
                                            <span className="label">MMSI (Est.)</span>
                                            <span className="value mono">{extractedData.vessel.mmsi}</span>
                                        </div>
                                        {extractedData.vessel.blNumber && (
                                            <div className="data-row">
                                                <span className="label">B/L Number</span>
                                                <span className="value mono">{extractedData.vessel.blNumber}</span>
                                            </div>
                                        )}
                                    </div>
                                </>
                            ) : (
                                <div className="error-message">
                                    <strong>Extraction Failed</strong>
                                    {extractedData?.error && (
                                        <p style={{ marginTop: 8 }}>{extractedData.error}</p>
                                    )}
                                    {extractedData?.isScannedPDF ? (
                                        <p style={{ marginTop: 8 }}>
                                            This PDF appears to be a <strong>scanned document</strong> (image-based).
                                            <br /><br />
                                            Please upload a <strong>digital PDF</strong> where text can be selected, or search for the vessel manually using the vessel name from your document.
                                        </p>
                                    ) : (
                                        <p style={{ marginTop: 8 }}>
                                            Could not identify vessel details in this PDF.
                                            <br /><br />
                                            Please ensure the document contains vessel information (name, voyage number, ports) or search manually.
                                        </p>
                                    )}
                                </div>
                            )}

                            <div className="action-buttons">
                                <button className="secondary-btn" onClick={() => setExtractedData(null)}>
                                    Try Another File
                                </button>
                                {hasData && (
                                    <button className="primary-btn" onClick={handleConfirm}>
                                        Import & Track Vessel
                                    </button>
                                )}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    )
}

export default ImportPanel
