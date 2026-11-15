/** @type {import('next').NextConfig} */
const nextConfig = {
  // the shared packages ship TypeScript source
  transpilePackages: ['@ckb-mines/chain', '@ckb-mines/protocol'],
};
export default nextConfig;
