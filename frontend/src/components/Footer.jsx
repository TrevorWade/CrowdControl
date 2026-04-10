/**
 * Minimal footer with copyright and version info
 * Keeps TikTok's clean aesthetic
 */
export default function Footer() {
  return (
    <footer className="bg-tiktok-black border-t border-tiktok-gray px-6 py-3">
      <div className="flex items-center justify-between text-sm text-gray-400">
        <div>© 2026 CrowdControl</div>
        <div>v1.0.0</div>
      </div>
    </footer>
  );
}
