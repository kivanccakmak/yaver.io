import Link from "next/link";

const manuals = [
  {
    title: "CLI setup & usage guide",
    description:
      "Install the Yaver CLI, sign in, choose your AI agent, and learn the most useful commands.",
    href: "/manuals/cli-setup",
    tags: ["macOS", "Linux", "Windows"],
  },
  {
    title: "Auto-boot on power restore",
    description:
      "Configure your macOS, Linux, or desktop PC to automatically boot when power is restored after an outage — so Yaver CLI starts without manual intervention.",
    href: "/manuals/auto-boot",
    tags: ["macOS", "Linux", "BIOS"],
  },
];

export default function ManualsPage() {
  return (
    <div className="px-6 py-20">
      <div className="mx-auto max-w-3xl">
        <div className="mb-16 text-center">
          <h1 className="mb-4 text-3xl font-bold text-surface-50 md:text-4xl">
            Manuals
          </h1>
          <p className="text-sm text-surface-500">
            Step-by-step guides for getting the most out of Yaver.
          </p>
        </div>

        <div className="space-y-4">
          {manuals.map((manual) => (
            <Link
              key={manual.href}
              href={manual.href}
              className="card block transition-colors hover:border-surface-600"
            >
              <h2 className="mb-2 text-base font-semibold text-surface-100">
                {manual.title}
              </h2>
              <p className="mb-3 text-sm leading-relaxed text-surface-400">
                {manual.description}
              </p>
              <div className="flex gap-2">
                {manual.tags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded-full bg-surface-800 px-2.5 py-0.5 text-[11px] font-medium text-surface-400"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </Link>
          ))}
        </div>

        <div className="mt-12 text-center">
          <Link href="/" className="text-xs text-surface-500 hover:text-surface-50">
            Back to home
          </Link>
        </div>
      </div>
    </div>
  );
}
