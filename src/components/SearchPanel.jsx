import { useState, useCallback } from 'react'

// Search icon
const SearchIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="11" cy="11" r="8" />
        <path d="M21 21l-4.35-4.35" />
    </svg>
)

function SearchPanel({ query, onQueryChange, onSearch, isLoading }) {
    const [inputValue, setInputValue] = useState(query)

    const handleSubmit = useCallback((e) => {
        e.preventDefault()
        onSearch(inputValue)
    }, [inputValue, onSearch])

    const handleChange = useCallback((e) => {
        setInputValue(e.target.value)
        onQueryChange(e.target.value)
    }, [onQueryChange])

    return (
        <div className="search-panel">
            <form className="search-container" onSubmit={handleSubmit}>
                <input
                    type="text"
                    className="search-input"
                    placeholder="Search vessel by name, MMSI, or IMO..."
                    value={inputValue}
                    onChange={handleChange}
                    disabled={isLoading}
                />
                <button
                    type="submit"
                    className="search-btn"
                    disabled={isLoading || !inputValue.trim()}
                >
                    {isLoading ? (
                        <div className="spinner" style={{ width: 18, height: 18, borderWidth: 2 }} />
                    ) : (
                        <SearchIcon />
                    )}
                </button>
            </form>
        </div>
    )
}

export default SearchPanel
