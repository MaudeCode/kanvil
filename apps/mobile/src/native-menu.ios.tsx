import type { ReactNode } from "react";
import type { NativeStackHeaderItemMenu } from "@react-navigation/native-stack";
import { Button, Host, Label, Menu, Picker, RNHostView, Section, Toggle } from "@expo/ui/swift-ui";
import { disabled, menuActionDismissBehavior, pickerStyle, tag } from "@expo/ui/swift-ui/modifiers";

type Items = NativeStackHeaderItemMenu["menu"]["items"];
// The iOS renderer preserves the same groups, palette and symbols as the system header menu.
export default function NativeMenu({
  title,
  items,
  children,
}: {
  title: string;
  items: Items;
  children: ReactNode;
}) {
  function rows(entries: Items, prefix = ""): ReactNode {
    return entries.map((item, index) => {
      const key = `${prefix}${index}`;
      if (item.type === "submenu") {
        if (item.layout === "palette") {
          const options = item.items.flatMap((option) =>
            option.type === "action" && !option.hidden ? [option] : [],
          );
          return (
            <Picker<number>
              key={key}
              label={item.label}
              modifiers={[pickerStyle("palette"), menuActionDismissBehavior("enabled")]}
              selection={options.findIndex((option) => option.state === "on")}
              onSelectionChange={(next) => {
                const option = options[next];
                if (option && !option.disabled) option.onPress();
              }}
            >
              {options.map((option, i) => (
                <Label
                  key={`${key}.${i}`}
                  title={option.label}
                  {...(option.icon?.type === "sfSymbol" ? { systemImage: option.icon.name } : {})}
                  modifiers={[tag(i), disabled(option.disabled ?? false)]}
                />
              ))}
            </Picker>
          );
        }
        const content = rows(item.items, `${key}.`);
        return item.inline ? (
          <Section key={key} {...(item.label ? { title: item.label } : {})}>
            {content}
          </Section>
        ) : (
          <Menu key={key} label={item.label}>
            {content}
          </Menu>
        );
      }
      if (item.hidden) return null;
      const image = item.icon?.type === "sfSymbol" ? item.icon.name : undefined;
      const appearance = {
        ...(image ? { systemImage: image } : {}),
        modifiers: [disabled(item.disabled ?? false)],
      };
      return item.state === "on" || item.state === "off" ? (
        <Toggle
          key={key}
          label={item.label}
          isOn={item.state === "on"}
          onIsOnChange={item.onPress}
          {...appearance}
        />
      ) : (
        <Button
          key={key}
          label={item.label}
          onPress={item.onPress}
          {...(item.destructive ? { role: "destructive" } : {})}
          {...appearance}
        />
      );
    });
  }
  return (
    <Host matchContents ignoreSafeArea="all">
      <Menu
        label={
          <RNHostView matchContents>
            <>{children}</>
          </RNHostView>
        }
      >
        {title ? <Section title={title}>{rows(items)}</Section> : rows(items)}
      </Menu>
    </Host>
  );
}
