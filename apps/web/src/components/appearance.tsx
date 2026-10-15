import { Monitor, Moon, Palette, Sun } from "lucide-react";
import { z } from "zod";
import { useTheme, colorThemes, themeNames, modeNames } from "./theme-provider.tsx";
import { Button, Select, SelectItem } from "../ui.tsx";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu";
const modes = ["light", "dark", "system"] as const;
const modeIcons = { light: Sun, dark: Moon, system: Monitor };
export function ThemeMenu() {
  const theme = useTheme();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="Appearance" />}>
        <Palette />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Appearance</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={theme.mode}
            onValueChange={(value) => theme.setMode(z.enum(modes).parse(value))}
          >
            {modes.map((mode) => {
              const Icon = modeIcons[mode];
              return (
                <DropdownMenuRadioItem key={mode} value={mode}>
                  <Icon />
                  {modeNames[mode]}
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>Color theme</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={theme.color}
            onValueChange={(value) => theme.setColor(z.enum(colorThemes).parse(value))}
          >
            {colorThemes.map((color) => (
              <DropdownMenuRadioItem key={color} value={color}>
                <span className={`theme-swatch theme-swatch-${color}`} />
                {themeNames[color]}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
export function AppearanceSettings() {
  const theme = useTheme();
  return (
    <section>
      <h2>Appearance</h2>
      <div className="form-grid">
        <Select
          label="Theme"
          value={theme.mode}
          onValueChange={(value) => theme.setMode(z.enum(modes).parse(value))}
        >
          {modes.map((mode) => (
            <SelectItem key={mode} value={mode}>
              {modeNames[mode]}
            </SelectItem>
          ))}
        </Select>
        <Select
          label="Color theme"
          value={theme.color}
          onValueChange={(value) => theme.setColor(z.enum(colorThemes).parse(value))}
        >
          {colorThemes.map((color) => (
            <SelectItem key={color} value={color}>
              <span className={`theme-swatch theme-swatch-${color}`} />
              {themeNames[color]}
            </SelectItem>
          ))}
        </Select>
      </div>
    </section>
  );
}
