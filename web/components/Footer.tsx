export default function Footer() {
  return (
    <footer className="border-t border-surface-800 bg-surface-950">
      <div className="mx-auto max-w-6xl px-6 py-6">
        <p className="text-center text-xs text-surface-600">
          &copy; {new Date().getFullYear()} SIMKAB ELEKTRIK. All rights reserved.
        </p>
      </div>
    </footer>
  );
}
