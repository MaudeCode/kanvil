import {
  automationFilterLabels,
  automationFilters,
  difficulties,
  difficultyLabels,
  kindLabels,
  kinds,
  priorities,
  priorityLabels,
  stateLabels,
  states,
} from "@kanvil/contracts";

// The filter fields whose values are fixed; the rest come from the project.
export const fixedFilterChoices = () => ({
  status: states.map((state) => ({ value: state, label: stateLabels[state] })),
  priority: priorities.map((priority) => ({ value: priority, label: priorityLabels[priority] })),
  kind: kinds.map((kind) => ({ value: kind, label: kindLabels[kind] })),
  difficulty: difficulties.map((difficulty) => ({
    value: difficulty,
    label: difficultyLabels[difficulty],
  })),
  automation: automationFilters.map((value) => ({
    value,
    label: automationFilterLabels[value],
  })),
});
