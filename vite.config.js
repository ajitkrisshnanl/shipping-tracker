import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
    plugins: [react()],
    server: {
        port: 5173,
        proxy: {
            '/api': {
                target: 'http://localhost:3001',
                changeOrigin: true,
            }
        }
    },
    build: {
        // Code splitting for better caching
        rollupOptions: {
            output: {
                manualChunks: {
                    // Vendor chunk for React
                    'react-vendor': ['react', 'react-dom'],
                    // Map libraries in separate chunk
                    'map-vendor': ['leaflet', 'react-leaflet']
                }
            }
        },
        // Optimize chunk size
        chunkSizeWarningLimit: 500,
        // Enable minification with esbuild (faster, built-in)
        minify: 'esbuild',
        esbuild: {
            drop: ['console', 'debugger']
        },
        // Generate source maps for debugging (optional in production)
        sourcemap: false,
        // Target modern browsers for smaller bundles
        target: 'es2020'
    }
})
