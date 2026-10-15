import { Button } from "./ui.tsx";

// Native-stack renders header actions outside the screen's route context.
export function createHeaderAction(title: string, onPress: () => void) {
  return function HeaderAction() {
    return <Button title={title} onPress={onPress} compact plain />;
  };
}
