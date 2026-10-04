/** @type {import('next').NextConfig} */
const nextConfig = {
  // Native / WASM packages must be loaded by Node, not bundled.
  serverExternalPackages: [
    '@huggingface/transformers',
    'onnxruntime-node',
    'sharp',
    '@electric-sql/pglite',
    '@electric-sql/pglite-pgvector',
    'pg',
  ],
  poweredByHeader: false,
};

export default nextConfig;
