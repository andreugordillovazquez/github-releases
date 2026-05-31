import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import framer from "vite-plugin-framer"
import mkcert from "vite-plugin-mkcert"

export default defineConfig(({ mode }) => {
    const plugins = mode === "http" ? [react(), framer()] : [react(), mkcert(), framer()]

    return {
        plugins,
    }
})
