export type ProjectPickerRow = {
  name: string;
  path: string;
  branch?: string;
  framework?: string;
};

/**
 * Keeps task project selection usable when a runner reports a large catalog.
 * The remembered/current project stays first, while a query searches every
 * piece of project context the user can see in the picker.
 */
export function visibleProjectPickerRows<T extends ProjectPickerRow>(
  projects: readonly T[],
  selectedPath: string,
  query: string,
): T[] {
  const needle = query.trim().toLocaleLowerCase();
  const visible = needle
    ? projects.filter((project) =>
        [project.name, project.path, project.branch, project.framework]
          .filter(Boolean)
          .some((value) => String(value).toLocaleLowerCase().includes(needle)),
      )
    : [...projects];

  const selectedIndex = visible.findIndex((project) => project.path === selectedPath);
  if (selectedIndex <= 0) return visible;
  return [visible[selectedIndex], ...visible.slice(0, selectedIndex), ...visible.slice(selectedIndex + 1)];
}
