import { createHeaderAction } from "./navigation-actions.tsx";
import { useDeferredValue, useLayoutEffect, useState } from "react";
import { View, Text } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { useInfiniteQuery } from "@tanstack/react-query";
import { z } from "zod";
import { states, stateLabels, priorityLabels, type Ticket } from "@kanvil/contracts";
import { useConnection, useProjects, useOperation } from "./data.tsx";
import {
  Body,
  Button,
  Sheet,
  Choice,
  ErrorNotice,
  Field,
  Loading,
  List,
  Row,
  Screen,
  Status,
  usePalette,
} from "./ui.tsx";
import type { ScreenProps } from "./navigation.ts";

export function Projects() {
  const navigation = useNavigation();
  const projects = useProjects();
  return (
    <Screen scroll={false}>
      <View style={{ padding: 16 }}>
        <NewProject />
      </View>
      <ErrorNotice error={projects.error} />
      {projects.isPending ? (
        <Loading />
      ) : (
        <List
          data={projects.data ?? []}
          keyExtractor={(project) => project.id}
          onRefresh={() => {
            void projects.refetch();
          }}
          refreshing={projects.isRefetching}
          ListEmptyComponent={
            <View style={{ padding: 20 }}>
              <Body muted>No projects yet</Body>
            </View>
          }
          renderItem={({ item }) => (
            <Row
              title={item.name}
              caption={`${item.key}${item.description ? ` · ${item.description}` : ""}`}
              onPress={() =>
                navigation.navigate("Tickets", { projectId: item.id, name: item.name })
              }
            />
          )}
        />
      )}
    </Screen>
  );
}
export function Tickets({ route, navigation }: ScreenProps<"Tickets">) {
  const { api } = useConnection(),
    color = usePalette(),
    projects = useProjects();
  const [query, setQuery] = useState(""),
    [status, setStatus] = useState("");
  const q = useDeferredValue(query),
    project = projects.data?.find(
      (item) =>
        item.id === route.params.projectId || item.key === route.params.projectId.toUpperCase(),
    ),
    projectId = project?.id ?? route.params.projectId;
  const input = {
    projectId,
    q,
    ...(status ? { status: z.enum(states).parse(status) } : {}),
    limit: 50,
  };
  const tickets = useInfiniteQuery({
    queryKey: ["kanvil", api.query("list_tickets", input).queryKey, "pages"],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api.call("list_tickets", { ...input, offset: pageParam }),
    getNextPageParam: (last, pages) => {
      const count = pages.reduce((sum, page) => sum + page.items.length, 0);
      return count < last.total ? count : undefined;
    },
  });
  useLayoutEffect(() => {
    navigation.setOptions({
      title: route.params.name ?? project?.name ?? "Tickets",
      headerRight: createHeaderAction("New ticket", () =>
        navigation.navigate("Edit", { projectId }),
      ),
    });
  }, [navigation, projectId, route.params.name, project?.name]);
  const rows = tickets.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Screen scroll={false}>
      <View style={{ padding: 16, gap: 12 }}>
        <Field
          label="Search tickets"
          value={query}
          onChangeText={setQuery}
          placeholder="Title, description, or key"
          returnKeyType="search"
        />
        <Choice
          label="Status"
          value={status}
          onChange={setStatus}
          options={[
            { value: "", label: "All statuses" },
            ...states.map((value) => ({ value, label: stateLabels[value] })),
          ]}
        />
        <ErrorNotice error={tickets.error} />
      </View>
      {tickets.isPending ? (
        <Loading />
      ) : (
        <List
          data={rows}
          keyExtractor={(ticket) => ticket.id}
          onRefresh={() => {
            void tickets.refetch();
          }}
          refreshing={tickets.isRefetching}
          onEndReached={() => {
            if (tickets.hasNextPage && !tickets.isFetchingNextPage) void tickets.fetchNextPage();
          }}
          onEndReachedThreshold={0.5}
          ListEmptyComponent={
            <View style={{ padding: 20 }}>
              <Body muted>No matching tickets</Body>
            </View>
          }
          ListFooterComponent={
            tickets.isFetchingNextPage ? (
              <Loading />
            ) : (
              <Text style={{ color: color.muted, textAlign: "center", padding: 20 }}>
                {rows.length} of {tickets.data?.pages[0]?.total ?? 0}
              </Text>
            )
          }
          renderItem={({ item }) => (
            <TicketRow
              ticket={item}
              onPress={() => navigation.navigate("Ticket", { projectId, ticketId: item.id })}
            />
          )}
        />
      )}
    </Screen>
  );
}
function TicketRow({ ticket, onPress }: { ticket: Ticket; onPress: () => void }) {
  return (
    <Row
      title={ticket.title}
      caption={`${ticket.key} · ${priorityLabels[ticket.priority]} · ${ticket.difficulty ?? "Unspecified difficulty"}`}
      trailing={<Status value={ticket.status} />}
      onPress={onPress}
    />
  );
}

function NewProject() {
  const [open, setOpen] = useState(false),
    [name, setName] = useState(""),
    [key, setKey] = useState(""),
    [description, setDescription] = useState("");
  const create = useOperation("create_project"),
    navigation = useNavigation();
  return (
    <>
      <Button title="New project" primary onPress={() => setOpen(true)} />
      <Sheet title="New project" open={open} onClose={() => setOpen(false)}>
        <Field label="Project name" value={name} onChangeText={setName} maxLength={120} />
        <Field
          label="Permanent ticket prefix"
          value={key}
          onChangeText={(value) => setKey(value.toUpperCase())}
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={10}
        />
        <Field
          label="Description"
          value={description}
          onChangeText={setDescription}
          multiline
          maxLength={5000}
        />
        <ErrorNotice error={create.error} />
        <Button
          title="Create project"
          disabled={create.isPending || !name.trim() || key.length < 2}
          primary
          onPress={() => {
            void create
              .mutateAsync({ name, key, description })
              .then((project) => {
                setOpen(false);
                navigation.navigate("Tickets", { projectId: project.id, name: project.name });
              })
              .catch(() => {});
          }}
        />
      </Sheet>
    </>
  );
}
