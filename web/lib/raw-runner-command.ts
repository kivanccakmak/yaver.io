export function isRawRunnerCommand(input: string | null | undefined): boolean {
  return (input || "").trimStart().startsWith("/");
}
