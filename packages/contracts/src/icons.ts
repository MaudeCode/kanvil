// Both apps use the exact icon library already installed for the web project picker.
export const loadProjectIcons = async () => (await import("@iconify-json/lucide")).icons;
