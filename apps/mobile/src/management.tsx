import { parseCustomFieldDraft } from "@kanvil/contracts/drafts";
import { useLayoutEffect, useState } from "react";
import { Alert, Share, View } from "react-native";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import * as Crypto from "expo-crypto";
import { useQuery } from "@tanstack/react-query";
import {
  capabilitiesOf,
  permissionLabels,
  permissions,
  roleLabels,
  roles,
  labelColor,
  projectIconColors,
  customFieldTypes,
  customFieldTypeLabels,
  states,
  stateLabels,
  operations,
  type Workspace,
  type Output,
  type CustomField,
  type CustomFieldValue,
} from "@kanvil/contracts";
import { t } from "@kanvil/contracts/i18n";
import {
  projectSections,
  workspaceSections,
  settingsSectionLabel,
  type SettingsSection,
} from "@kanvil/contracts/navigation";
import {
  useAllProjects,
  useConnection,
  useIdentity,
  useOperation,
  useProjectAccess,
  useWorkspace,
} from "./data.tsx";
import {
  nativeHeaderOptions,
  Body,
  Button,
  Check,
  Choice,
  ErrorNotice,
  Field,
  Loading,
  Row,
  Screen,
  Section,
  Sheet,
  CustomFieldInput,
} from "./ui.tsx";
import type { ScreenProps } from "./navigation.ts";
import { IntegrationSettings, CalendarFeeds } from "./delivery-settings.tsx";
import { ProjectAppearance } from "./project-appearance.tsx";
export { Administration } from "./administration.tsx";
export { ImportProject } from "./imports.tsx";

// The web SettingsLayout needs DOM controls. Native settings share its section catalog and use
// the existing Screen, Sheet, Row and field renderers instead.
export function useSettingsSection(
  navigation: Pick<ScreenProps<"WorkspaceSettings">["navigation"], "setOptions">,
  sections: readonly SettingsSection[],
  initial?: string,
) {
  const [section, setSection] = useState<SettingsSection>(
    sections.find((value) => value === initial) ?? sections[0] ?? "general",
  );
  useLayoutEffect(() => {
    navigation.setOptions(
      nativeHeaderOptions({
        unstable_headerRightItems: () => [
          {
            type: "menu",
            label: t("settings.layout.section"),
            accessibilityLabel: t("settings.layout.section"),
            icon: { type: "sfSymbol", name: "list.bullet" },
            menu: {
              items: sections.map((value) => ({
                type: "action",
                label: settingsSectionLabel(value),
                state: value === section ? "on" : "off",
                onPress: () => setSection(value),
              })),
            },
          },
        ],
      }),
    );
  }, [navigation, section, sections]);
  return section;
}

export function DetailsForm({
  entity,
  disabled,
  pending,
  error,
  onSave,
}: {
  entity: { name: string; description: string; version: number };
  disabled: boolean;
  pending: boolean;
  error: unknown;
  onSave: (fields: {
    name: string;
    description: string;
    expectedVersion: number;
  }) => Promise<{ version: number }>;
}) {
  const [name, setName] = useState(entity.name),
    [description, setDescription] = useState(entity.description),
    [version, setVersion] = useState(entity.version);
  const stale = version !== entity.version;
  return (
    <Section title={t("shell.settingsNav.section.general")}>
      <Field
        label={t("settings.layout.name")}
        value={name}
        onChangeText={setName}
        editable={!disabled && !pending}
        maxLength={120}
      />
      <Field
        label={t("settings.layout.description")}
        value={description}
        onChangeText={setDescription}
        editable={!disabled && !pending}
        multiline
        maxLength={5000}
      />
      <ErrorNotice error={error} />
      {stale && (
        <>
          <Body>{t("settings.layout.stale")}</Body>
          <Button
            title={t("common.action.cancel")}
            onPress={() => {
              setName(entity.name);
              setDescription(entity.description);
              setVersion(entity.version);
            }}
          />
        </>
      )}
      {!disabled && (
        <Button
          title={t("common.action.save")}
          primary
          disabled={pending || stale || !name.trim()}
          onPress={() => {
            void onSave({ name, description, expectedVersion: version })
              .then((saved) => setVersion(saved.version))
              .catch(() => {});
          }}
        />
      )}
    </Section>
  );
}

export function CreateWorkspace({ navigation }: ScreenProps<"CreateWorkspace">) {
  const [name, setName] = useState(""),
    [slug, setSlug] = useState(""),
    [description, setDescription] = useState("");
  const create = useOperation("create_workspace"),
    workspace = useWorkspace();
  return (
    <Screen form>
      <Field
        label={t("shell.workspace.name")}
        value={name}
        onChangeText={setName}
        maxLength={120}
      />
      <Field
        label={t("shell.workspace.key")}
        value={slug}
        onChangeText={(value) => setSlug(value.toLowerCase())}
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={80}
      />
      <Field
        label={t("settings.layout.description")}
        value={description}
        onChangeText={setDescription}
        multiline
      />
      <ErrorNotice error={create.error} />
      <Button
        title={t("shell.workspace.create")}
        primary
        disabled={create.isPending || !name.trim() || !/^[a-z0-9][a-z0-9-]{1,79}$/.test(slug)}
        onPress={() => {
          void create
            .mutateAsync({ name, slug, description })
            .then((space) => {
              workspace.select(space.id);
              navigation.goBack();
            })
            .catch(() => {});
        }}
      />
    </Screen>
  );
}

export function WorkspaceSettings({ route, navigation }: ScreenProps<"WorkspaceSettings">) {
  const { workspaceId } = route.params,
    workspace = useWorkspace(),
    identity = useIdentity(),
    { api } = useConnection();
  const section = useSettingsSection(navigation, workspaceSections, route.params.section);
  const spaces = useQuery(api.query("list_workspaces", {}));
  const space = spaces.data?.find((item) => item.id === workspaceId);
  const update = useOperation("update_workspace");
  if (spaces.isPending) return <Loading />;
  if (!space)
    return <ErrorNotice error={spaces.error ?? new Error(t("shell.app.noWorkspaceSelected"))} />;
  const granted = identity.admin ? permissions : capabilitiesOf(space);
  return (
    <Screen>
      <Body muted small>
        {space.name}
      </Body>
      {section === "general" && (
        <>
          <DetailsForm
            entity={space}
            disabled={!granted.includes("workspace.manage")}
            pending={update.isPending}
            error={update.error}
            onSave={(fields) => update.mutateAsync({ workspaceId, ...fields })}
          />
          <WorkspaceLifecycle
            space={space}
            onDeleted={() => {
              workspace.select(
                workspace.workspaces.find((item) => item.id !== workspaceId)?.id ?? "",
              );
              navigation.goBack();
            }}
          />
          <Button
            title={t("admin.import.title")}
            onPress={() => navigation.navigate("Import", { workspaceId })}
          />
        </>
      )}
      {section === "members" && (
        <>
          <Members workspaceId={workspaceId} canManage={granted.includes("member.manage")} />
          <Invitations
            workspaceId={workspaceId}
            canManage={granted.includes("invitation.manage")}
          />
        </>
      )}
      {section === "roles" && (
        <Roles
          workspaceId={workspaceId}
          canManage={granted.includes("workspace.manage")}
          granted={granted}
        />
      )}
      {section === "labels" && (
        <Labels workspaceId={workspaceId} canManage={granted.includes("workspace.manage")} />
      )}
    </Screen>
  );
}

function WorkspaceLifecycle({ space, onDeleted }: { space: Workspace; onDeleted: () => void }) {
  const { api } = useConnection(),
    identity = useIdentity();
  const canTransfer = identity.admin || space.ownerId === identity.id;
  const members = useQuery({
    ...api.query("list_workspace_members", { workspaceId: space.id }),
    enabled: !!space.role || identity.admin,
  });
  const transfer = useOperation("transfer_workspace"),
    remove = useOperation("delete_workspace");
  const [open, setOpen] = useState(false),
    [target, setTarget] = useState(""),
    [confirm, setConfirm] = useState("");
  const impact = useQuery({
    ...api.query("get_workspace_impact", { workspaceId: space.id }),
    enabled: open && canTransfer,
  });
  return (
    <Section title={t("settings.workspace.owner")}>
      <Body>
        {members.data?.find((person) => person.userId === space.ownerId)?.name ??
          t("settings.workspace.noOwner")}
      </Body>
      {canTransfer && (
        <>
          <Choice
            label={t("settings.workspace.newOwner")}
            value={target}
            onChange={setTarget}
            options={[
              { value: "", label: t("ticket.userPicker.placeholder") },
              ...(members.data ?? [])
                .filter(
                  (person) =>
                    person.role === "admin" && !person.disabled && person.userId !== space.ownerId,
                )
                .map((person) => ({
                  value: person.userId,
                  label: `${person.name} · ${person.email}`,
                })),
            ]}
          />
          <Button
            title={t("settings.workspace.transfer")}
            disabled={!target || transfer.isPending}
            onPress={() =>
              Alert.alert(t("settings.workspace.transfer"), space.name, [
                { text: t("common.action.cancel"), style: "cancel" },
                {
                  text: t("common.action.confirm"),
                  onPress: () =>
                    transfer.mutate({
                      workspaceId: space.id,
                      expectedVersion: space.version,
                      userId: target,
                    }),
                },
              ])
            }
          />
          <Button
            title={t("settings.lifecycle.deleteWorkspace")}
            danger
            onPress={() => setOpen(true)}
          />
          <Sheet
            title={t("settings.lifecycle.deleteWorkspace")}
            open={open}
            onClose={() => {
              if (!remove.isPending) setOpen(false);
            }}
          >
            <Impact value={impact.data} />
            <Field
              label={t("shell.workspace.key")}
              value={confirm}
              onChangeText={setConfirm}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <ErrorNotice error={impact.error ?? remove.error} />
            <Button
              title={t("settings.lifecycle.deleteWorkspace")}
              danger
              disabled={
                confirm !== space.slug ||
                !impact.data ||
                !!impact.data.blockers.length ||
                remove.isPending
              }
              onPress={() => {
                void remove
                  .mutateAsync({
                    workspaceId: space.id,
                    expectedVersion: space.version,
                    confirmSlug: confirm,
                  })
                  .then(onDeleted)
                  .catch(() => {});
              }}
            />
          </Sheet>
        </>
      )}
      <ErrorNotice error={members.error ?? transfer.error} />
    </Section>
  );
}

function Impact({
  value,
}: {
  value: Output<"get_project_impact"> | Output<"get_workspace_impact"> | undefined;
}) {
  return value ? (
    <View style={{ gap: 12 }}>
      <Body>
        {t("native.labelValue", { label: t("shell.page.tickets"), value: value.tickets })}
      </Body>
      <Body>
        {t("native.labelValue", { label: t("native.discussion.title"), value: value.comments })}
      </Body>
      <Body>
        {t("native.labelValue", { label: t("native.attachments.title"), value: value.attachments })}
      </Body>
      {"transfer" in value && value.transfer && (
        <>
          {(["losingAccess", "gainingAccess"] as const).map((key) => (
            <Section
              key={key}
              title={t(
                key === "losingAccess"
                  ? "settings.lifecycle.row.losesAccess"
                  : "settings.lifecycle.row.gainsAccess",
              )}
            >
              {value.transfer?.[key].length ? (
                value.transfer[key].map((person) => (
                  <Body key={person.userId}>
                    {person.name} · {person.email}
                  </Body>
                ))
              ) : (
                <Body muted>{t("settings.lifecycle.noOne")}</Body>
              )}
            </Section>
          ))}
          <Body>
            {t("native.labelValue", {
              label: t("settings.lifecycle.row.labelsCopied"),
              value: value.transfer.copiedLabels.join(", ") || t("settings.lifecycle.noOne"),
            })}
          </Body>
          <Body>
            {t("native.labelValue", {
              label: t("settings.lifecycle.row.labelsMerged"),
              value: value.transfer.mergedLabels.join(", ") || t("settings.lifecycle.noOne"),
            })}
          </Body>
          <Body>
            {t("native.labelValue", {
              label: t("settings.lifecycle.row.followsRemoved"),
              value: value.transfer.subscriptions,
            })}
          </Body>
          <Body>
            {t("settings.lifecycle.transferInvitations", { count: value.transfer.invitations })}
          </Body>
        </>
      )}
      {value.blockers.map((item) => (
        <Body key={item.code}>{item.message}</Body>
      ))}
    </View>
  ) : (
    <Loading />
  );
}

function Members({
  workspaceId,
  projectId,
  canManage,
}: {
  workspaceId: string;
  projectId?: string;
  canManage: boolean;
}) {
  const { api } = useConnection();
  const people = useQuery<Output<"list_members">>(
    projectId
      ? api.query("list_members", { projectId })
      : api.query("list_workspace_members", { workspaceId }),
  );
  const options = useQuery<Output<"list_project_roles">>(
    projectId
      ? api.query("list_project_roles", { projectId })
      : api.query("list_workspace_roles", { workspaceId }),
  );
  const projectMember = useOperation("set_member"),
    workspaceMember = useOperation("set_workspace_member");
  const [email, setEmail] = useState(""),
    [role, setRole] = useState<string>("writer"),
    [editing, setEditing] = useState(false);
  const pending = projectMember.isPending || workspaceMember.isPending;
  function save(next: string | null) {
    const promise = projectId
      ? projectMember.mutateAsync({ projectId, email, role: next })
      : workspaceMember.mutateAsync({ workspaceId, email, role: next });
    void promise.then(() => setEditing(false)).catch(() => {});
  }
  return (
    <Section title={t("shell.settingsNav.section.members")}>
      <ErrorNotice error={people.error ?? options.error} />
      {people.isPending ? (
        <Loading />
      ) : (
        people.data?.map((person) => (
          <Row
            key={person.userId}
            title={person.name}
            caption={`${person.email} · ${options.data?.find((item) => item.id === (person.roleId ?? person.role))?.name ?? roleLabels[person.role]}`}
            onPress={() => {
              if (canManage) {
                setEmail(person.email);
                setRole(person.roleId ?? person.role);
                setEditing(true);
              }
            }}
          />
        ))
      )}
      {canManage && (
        <Button
          title={t("settings.members.add")}
          onPress={() => {
            setEmail("");
            setRole("writer");
            setEditing(true);
          }}
        />
      )}
      <Sheet
        title={t("shell.settingsNav.section.members")}
        open={editing}
        onClose={() => {
          if (!pending) setEditing(false);
        }}
      >
        <Field
          label={t("native.login.email")}
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
        />
        <Choice
          label={t("settings.invitations.role")}
          value={role}
          onChange={setRole}
          options={(options.data ?? []).map((item) => ({ value: item.id, label: item.name }))}
        />
        <ErrorNotice error={projectMember.error ?? workspaceMember.error} />
        <Button
          title={t("common.action.save")}
          primary
          disabled={!email.includes("@") || pending}
          onPress={() => save(role)}
        />
        {people.data?.some((person) => person.email === email) && (
          <Button
            title={t("settings.members.remove")}
            danger
            disabled={pending}
            onPress={() =>
              Alert.alert(t("settings.members.remove"), email, [
                { text: t("common.action.cancel"), style: "cancel" },
                {
                  text: t("common.action.confirm"),
                  style: "destructive",
                  onPress: () => save(null),
                },
              ])
            }
          />
        )}
      </Sheet>
    </Section>
  );
}

function Invitations({ workspaceId, canManage }: { workspaceId: string; canManage: boolean }) {
  const { api } = useConnection();
  const invitations = useQuery({
    ...api.query("list_invitations", { workspaceId }),
    enabled: canManage,
  });
  const create = useOperation("create_invitation"),
    resend = useOperation("resend_invitation"),
    revoke = useOperation("revoke_invitation");
  const [open, setOpen] = useState(false),
    [email, setEmail] = useState(""),
    [role, setRole] = useState<(typeof roles)[number]>("writer"),
    [url, setUrl] = useState("");
  if (!canManage) return null;
  return (
    <Section title={t("settings.invitations.title")}>
      <ErrorNotice error={invitations.error ?? resend.error ?? revoke.error} />
      {invitations.data?.map((item) => (
        <View key={item.id} style={{ gap: 8 }}>
          <Body>{item.email}</Body>
          <Body muted small>
            {item.status}
          </Body>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button
              title={t("settings.invitations.resend")}
              disabled={resend.isPending}
              onPress={() => {
                void resend
                  .mutateAsync({
                    workspaceId,
                    invitationId: item.id,
                    expectedVersion: item.version,
                  })
                  .then((value) => {
                    setUrl(value.url);
                    setOpen(true);
                  })
                  .catch(() => {});
              }}
            />
            <Button
              title={t("settings.invitations.revoke")}
              danger
              disabled={revoke.isPending}
              onPress={() =>
                revoke.mutate({ workspaceId, invitationId: item.id, expectedVersion: item.version })
              }
            />
          </View>
        </View>
      ))}
      <Button
        title={t("settings.invitations.invite")}
        onPress={() => {
          setUrl("");
          setOpen(true);
        }}
      />
      <Sheet
        title={t("settings.invitations.invite")}
        open={open}
        onClose={() => {
          if (!create.isPending) setOpen(false);
        }}
      >
        {url ? (
          <>
            <Body>{url}</Body>
            <Button
              title={t("native.detail.share")}
              onPress={() => {
                void Share.share({ message: url });
              }}
            />
          </>
        ) : (
          <>
            <Field
              label={t("native.login.email")}
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              keyboardType="email-address"
            />
            <Choice
              label={t("settings.invitations.role")}
              value={role}
              options={roles.map((value) => ({ value, label: roleLabels[value] }))}
              onChange={(value) => {
                const next = roles.find((item) => item === value);
                if (next) setRole(next);
              }}
            />
            <ErrorNotice error={create.error} />
            <Button
              title={t("settings.invitations.invite")}
              primary
              disabled={!email.includes("@") || create.isPending}
              onPress={() => {
                void create
                  .mutateAsync({ workspaceId, email, role })
                  .then((value) => setUrl(value.url))
                  .catch(() => {});
              }}
            />
          </>
        )}
      </Sheet>
    </Section>
  );
}

function Roles({
  workspaceId,
  canManage,
  granted,
}: {
  workspaceId: string;
  canManage: boolean;
  granted: readonly (typeof permissions)[number][];
}) {
  const { api } = useConnection(),
    all = useQuery(api.query("list_workspace_roles", { workspaceId }));
  const create = useOperation("create_workspace_role"),
    update = useOperation("update_workspace_role"),
    remove = useOperation("delete_workspace_role");
  const [editing, setEditing] = useState<
      Output<"list_workspace_roles">[number] | null | undefined
    >(),
    [name, setName] = useState(""),
    [selected, setSelected] = useState<(typeof permissions)[number][]>([]),
    [reassignTo, setReassignTo] = useState("reader");
  const pending = create.isPending || update.isPending || remove.isPending;
  return (
    <Section title={t("shell.settingsNav.section.roles")}>
      <ErrorNotice error={all.error} />
      {all.data?.map((item) => (
        <Row
          key={item.id}
          title={item.name}
          caption={item.permissions
            .map((permission) => permissionLabels[permission].label)
            .join(", ")}
          onPress={() => {
            if (canManage && !item.seeded) {
              setEditing(item);
              setName(item.name);
              setSelected(item.permissions);
            }
          }}
        />
      ))}
      {canManage && (
        <Button
          title={t("settings.roles.new")}
          onPress={() => {
            setEditing(null);
            setName("");
            setSelected([]);
          }}
        />
      )}
      <Sheet
        title={t("shell.settingsNav.section.roles")}
        open={editing !== undefined}
        onClose={() => {
          if (!pending) setEditing(undefined);
        }}
      >
        <Field
          label={t("settings.layout.name")}
          value={name}
          onChangeText={setName}
          maxLength={40}
        />
        {permissions.map((permission) => (
          <Check
            key={permission}
            label={permissionLabels[permission].label}
            checked={selected.includes(permission)}
            disabled={!granted.includes(permission) || pending}
            onChange={(value) =>
              setSelected((previous) =>
                value ? [...previous, permission] : previous.filter((item) => item !== permission),
              )
            }
          />
        ))}
        <ErrorNotice error={create.error ?? update.error ?? remove.error} />
        <Button
          title={t("common.action.save")}
          primary
          disabled={!name.trim() || pending}
          onPress={() => {
            void (
              editing
                ? update.mutateAsync({
                    workspaceId,
                    roleId: editing.id,
                    expectedVersion: editing.version,
                    name,
                    permissions: selected,
                  })
                : create.mutateAsync({ workspaceId, name, permissions: selected })
            )
              .then(() => setEditing(undefined))
              .catch(() => {});
          }}
        />
        {editing && (
          <>
            <Choice
              label={t("settings.invitations.role")}
              value={reassignTo}
              onChange={setReassignTo}
              options={(all.data ?? [])
                .filter((item) => item.id !== editing.id)
                .map((item) => ({ value: item.id, label: item.name }))}
            />
            <Button
              title={t("common.action.delete")}
              danger
              disabled={pending}
              onPress={() =>
                Alert.alert(t("common.action.delete"), editing.name, [
                  { text: t("common.action.cancel"), style: "cancel" },
                  {
                    text: t("common.action.confirm"),
                    style: "destructive",
                    onPress: () => {
                      void remove
                        .mutateAsync({
                          workspaceId,
                          roleId: editing.id,
                          expectedVersion: editing.version,
                          reassignTo,
                        })
                        .then(() => setEditing(undefined))
                        .catch(() => {});
                    },
                  },
                ])
              }
            />
          </>
        )}
      </Sheet>
    </Section>
  );
}

function Labels({
  workspaceId,
  projectId,
  canManage,
}: {
  workspaceId: string;
  projectId?: string;
  canManage: boolean;
}) {
  const { api } = useConnection();
  const labels = useQuery<{ id: string; name: string; color: string; version: number }[]>(
    projectId
      ? api.query("list_project_labels", { projectId })
      : api.query("list_workspace_labels", { workspaceId }),
  );
  const createProject = useOperation("create_project_label"),
    createWorkspace = useOperation("create_workspace_label"),
    updateProject = useOperation("update_project_label"),
    updateWorkspace = useOperation("update_workspace_label"),
    deleteProject = useOperation("delete_project_label"),
    deleteWorkspace = useOperation("delete_workspace_label");
  const [editing, setEditing] = useState<
      { id: string; name: string; color: string; version: number } | null | undefined
    >(),
    [name, setName] = useState(""),
    [color, setColor] = useState("gray");
  const pending =
    createProject.isPending ||
    createWorkspace.isPending ||
    updateProject.isPending ||
    updateWorkspace.isPending ||
    deleteProject.isPending ||
    deleteWorkspace.isPending;
  return (
    <Section title={t("shell.settingsNav.section.labels")}>
      <ErrorNotice error={labels.error} />
      {labels.data?.map((item) => (
        <Row
          key={item.id}
          title={item.name}
          caption={item.color}
          onPress={() => {
            if (canManage) {
              setName(item.name);
              setColor(item.color);
              setEditing(item);
            }
          }}
        />
      ))}
      {canManage && (
        <Button
          title={t("settings.labels.new")}
          onPress={() => {
            setEditing(null);
            setName("");
            setColor("gray");
          }}
        />
      )}
      <Sheet
        title={t("shell.settingsNav.section.labels")}
        open={editing !== undefined}
        onClose={() => {
          if (!pending) setEditing(undefined);
        }}
      >
        <Field
          label={t("settings.layout.name")}
          value={name}
          onChangeText={setName}
          maxLength={40}
        />
        <Choice
          label={t("settings.labels.color")}
          value={color}
          onChange={setColor}
          options={projectIconColors.map((value) => ({
            value,
            label: t(`settings.color.${value}`),
          }))}
        />
        <ErrorNotice
          error={
            createProject.error ??
            createWorkspace.error ??
            updateProject.error ??
            updateWorkspace.error ??
            deleteProject.error ??
            deleteWorkspace.error
          }
        />
        <Button
          title={t("common.action.save")}
          primary
          disabled={!name.trim() || pending}
          onPress={() => {
            const parsedColor = labelColor.parse(color);
            const promise = projectId
              ? editing
                ? updateProject.mutateAsync({
                    projectId,
                    labelId: editing.id,
                    expectedVersion: editing.version,
                    name,
                    color: parsedColor,
                  })
                : createProject.mutateAsync({ projectId, name, color: parsedColor })
              : editing
                ? updateWorkspace.mutateAsync({
                    workspaceId,
                    labelId: editing.id,
                    expectedVersion: editing.version,
                    name,
                    color: parsedColor,
                  })
                : createWorkspace.mutateAsync({ workspaceId, name, color: parsedColor });
            void promise.then(() => setEditing(undefined)).catch(() => {});
          }}
        />
        {editing && (
          <Button
            title={t("common.action.delete")}
            danger
            disabled={pending}
            onPress={() =>
              Alert.alert(t("common.action.delete"), editing.name, [
                { text: t("common.action.cancel"), style: "cancel" },
                {
                  text: t("common.action.confirm"),
                  style: "destructive",
                  onPress: () => {
                    void (
                      projectId
                        ? deleteProject.mutateAsync({
                            projectId,
                            labelId: editing.id,
                            expectedVersion: editing.version,
                          })
                        : deleteWorkspace.mutateAsync({
                            workspaceId,
                            labelId: editing.id,
                            expectedVersion: editing.version,
                          })
                    )
                      .then(() => setEditing(undefined))
                      .catch(() => {});
                  },
                },
              ])
            }
          />
        )}
      </Sheet>
    </Section>
  );
}

export function ProjectSettings({ route, navigation }: ScreenProps<"ProjectSettings">) {
  const { projectId } = route.params,
    projects = useAllProjects(),
    access = useProjectAccess(projectId),
    { api } = useConnection();
  const section = useSettingsSection(navigation, projectSections, route.params.section);
  const result = useQuery(api.query("get_project", { projectId }));
  const update = useOperation("update_project"),
    project = result.data;
  if (result.isPending) return <Loading />;
  if (!project) return <ErrorNotice error={result.error} />;
  return (
    <Screen>
      <Body muted small>
        {project.key} · {project.name}
      </Body>
      {section === "general" && (
        <>
          <DetailsForm
            entity={project}
            disabled={!access.canManage}
            pending={update.isPending}
            error={update.error}
            onSave={(fields) => update.mutateAsync({ projectId, ...fields })}
          />
          <Choice
            label={t("settings.project.access")}
            disabled={!access.canManage || update.isPending}
            value={project.visibility}
            options={[
              { value: "private", label: t("settings.project.visibility.private") },
              { value: "workspace", label: t("settings.project.visibility.workspace") },
            ]}
            onChange={(value) => {
              if (access.canManage)
                update.mutate({
                  projectId,
                  expectedVersion: project.version,
                  name: project.name,
                  description: project.description,
                  visibility: value === "workspace" ? "workspace" : "private",
                });
            }}
          />
          {access.canShare && (
            <>
              <Check
                label={t("settings.project.publicLink")}
                checked={project.publicReadEnabled}
                disabled={update.isPending}
                onChange={(publicReadEnabled) =>
                  update.mutate({
                    projectId,
                    expectedVersion: project.version,
                    name: project.name,
                    description: project.description,
                    publicReadEnabled,
                  })
                }
              />
              <Body muted small>
                {t("settings.project.publicDisclosure")}
              </Body>
              <Button
                title={t("settings.project.copyPublicLink")}
                disabled={!project.publicReadEnabled}
                onPress={() => {
                  void Share.share({
                    message: `${api.query("get_project", { projectId }).queryKey[1]}/public/projects/${projectId}`,
                  });
                }}
              />
            </>
          )}
          <ProjectPrefix project={project} disabled={!access.canManage} />
          <ProjectAppearance project={project} disabled={!access.canAdmin} />
          <ProjectLifecycle
            project={project}
            canManage={access.canManage}
            onDeleted={() => navigation.popTo("Home")}
          />
        </>
      )}
      {section === "members" && (
        <Members
          workspaceId={project.workspaceId}
          projectId={projectId}
          canManage={access.canManageMembers}
        />
      )}
      {section === "labels" && (
        <Labels
          workspaceId={project.workspaceId}
          projectId={projectId}
          canManage={access.canAdmin}
        />
      )}
      {section === "workflow" && (
        <WorkflowSettings projectId={projectId} canManage={access.canAdmin} />
      )}
      {section === "fields" && <FieldSettings projectId={projectId} canManage={access.canAdmin} />}
      {section === "integrations" && (
        <IntegrationSettings projectId={projectId} canManage={access.canAdmin} />
      )}
      {section === "calendar" && (
        <CalendarFeeds projectId={projectId} canManage={access.canShare} />
      )}
      <ErrorNotice error={projects.error} />
    </Screen>
  );
}

function ProjectPrefix({
  project,
  disabled,
}: {
  project: Output<"get_project">;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Section title={t("settings.project.prefix")}>
      <Body>{project.key}</Body>
      {!disabled && (
        <Button title={t("settings.project.changePrefix")} onPress={() => setOpen(true)} />
      )}
      <Sheet
        title={t("settings.project.changePrefixTitle")}
        open={open}
        onClose={() => setOpen(false)}
      >
        {open && <PrefixForm project={project} onSaved={() => setOpen(false)} />}
      </Sheet>
    </Section>
  );
}
function PrefixForm({ project, onSaved }: { project: Output<"get_project">; onSaved: () => void }) {
  const [snapshot] = useState(project),
    [key, setKey] = useState(project.key),
    update = useOperation("update_project");
  return (
    <>
      <Body>{t("settings.project.changePrefixDescription")}</Body>
      <Field
        label={t("settings.project.prefix")}
        value={key}
        onChangeText={(value) => setKey(value.toUpperCase())}
        autoCapitalize="characters"
        autoCorrect={false}
        maxLength={10}
      />
      <ErrorNotice error={update.error} />
      <Button
        title={t("settings.project.changePrefix")}
        primary
        disabled={
          !operations.update_project.input.shape.key.safeParse(key).success ||
          key === snapshot.key ||
          update.isPending
        }
        onPress={() => {
          void update
            .mutateAsync({
              projectId: snapshot.id,
              expectedVersion: snapshot.version,
              name: snapshot.name,
              description: snapshot.description,
              key,
            })
            .then(onSaved)
            .catch(() => {});
        }}
      />
    </>
  );
}

function ProjectLifecycle({
  project,
  canManage,
  onDeleted,
}: {
  project: Output<"get_project">;
  canManage: boolean;
  onDeleted: () => void;
}) {
  const { api } = useConnection(),
    workspace = useWorkspace();
  const archive = useOperation("archive_project"),
    remove = useOperation("delete_project"),
    transfer = useOperation("transfer_project");
  const [mode, setMode] = useState<"delete" | "move">(),
    [destination, setDestination] = useState(""),
    [confirmation, setConfirmation] = useState(""),
    [error, setError] = useState<unknown>();
  const impact = useQuery({
    ...api.query("get_project_impact", {
      projectId: project.id,
      ...(mode === "move" && destination ? { workspaceId: destination } : {}),
    }),
    enabled: !!mode && canManage,
  });
  async function exportProject() {
    const file = new File(Paths.cache, `${project.key}-export.json`);
    try {
      const bundle = await api.call("export_project", { projectId: project.id });
      await file.write(JSON.stringify(bundle, null, 2));
      await Sharing.shareAsync(file.uri, { mimeType: "application/json", UTI: "public.json" });
    } catch (cause) {
      setError(cause);
    } finally {
      if (file.exists) file.delete();
    }
  }
  return (
    <Section title={t("shell.settingsNav.section.general")}>
      <Button
        title={t("settings.lifecycle.export")}
        onPress={() => {
          void exportProject();
        }}
      />
      {canManage && (
        <>
          <Button
            title={
              project.archivedAt ? t("settings.lifecycle.restore") : t("settings.lifecycle.archive")
            }
            disabled={archive.isPending}
            onPress={() =>
              Alert.alert(
                project.archivedAt
                  ? t("settings.lifecycle.restore")
                  : t("settings.lifecycle.archive"),
                project.name,
                [
                  { text: t("common.action.cancel"), style: "cancel" },
                  {
                    text: t("common.action.confirm"),
                    onPress: () =>
                      archive.mutate({
                        projectId: project.id,
                        expectedVersion: project.version,
                        archived: !project.archivedAt,
                      }),
                  },
                ],
              )
            }
          />
          <Button
            title={t("settings.lifecycle.move")}
            onPress={() => {
              setMode("move");
              setDestination("");
            }}
          />
          <Button
            title={t("settings.lifecycle.deleteProject")}
            danger
            onPress={() => {
              setMode("delete");
              setConfirmation("");
            }}
          />
          <Sheet
            title={
              mode === "move" ? t("settings.lifecycle.move") : t("settings.lifecycle.deleteProject")
            }
            open={!!mode}
            onClose={() => {
              if (!remove.isPending && !transfer.isPending) setMode(undefined);
            }}
          >
            {mode === "move" && (
              <Choice
                label={t("settings.lifecycle.destination")}
                value={destination}
                options={[
                  { value: "", label: t("settings.lifecycle.destination") },
                  ...workspace.workspaces
                    .filter(
                      (space) =>
                        space.id !== project.workspaceId &&
                        capabilitiesOf(space).includes("project.manage"),
                    )
                    .map((space) => ({ value: space.id, label: space.name })),
                ]}
                onChange={setDestination}
              />
            )}
            <Impact value={impact.data} />
            {mode === "delete" && (
              <Field
                label={t("settings.lifecycle.typeToConfirm", { key: project.key })}
                value={confirmation}
                onChangeText={setConfirmation}
                autoCapitalize="characters"
                autoCorrect={false}
              />
            )}
            <ErrorNotice error={impact.error ?? remove.error ?? transfer.error} />
            <Button
              title={t("common.action.confirm")}
              danger={mode === "delete"}
              disabled={
                !impact.data ||
                !!impact.data.blockers.length ||
                remove.isPending ||
                transfer.isPending ||
                (mode === "move" ? !destination : confirmation !== project.key)
              }
              onPress={() => {
                void (
                  mode === "move"
                    ? transfer.mutateAsync({
                        projectId: project.id,
                        expectedVersion: project.version,
                        workspaceId: destination,
                      })
                    : remove.mutateAsync({
                        projectId: project.id,
                        expectedVersion: project.version,
                        confirmKey: confirmation,
                      })
                )
                  .then(() => {
                    setMode(undefined);
                    onDeleted();
                  })
                  .catch(() => {});
              }}
            />
          </Sheet>
        </>
      )}
      <ErrorNotice error={error ?? archive.error} />
    </Section>
  );
}

function WorkflowSettings({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const { api } = useConnection(),
    workflow = useQuery(api.query("list_workflow_states", { projectId }));
  const create = useOperation("create_workflow_state"),
    update = useOperation("update_workflow_state"),
    remove = useOperation("delete_workflow_state");
  const [editing, setEditing] = useState<
      Output<"list_workflow_states">[number] | null | undefined
    >(),
    [name, setName] = useState(""),
    [category, setCategory] = useState<(typeof states)[number]>("todo"),
    [color, setColor] = useState("default"),
    [reassignTo, setReassignTo] = useState("");
  const pending = create.isPending || update.isPending || remove.isPending;
  return (
    <Section title={t("settings.workflow.title")}>
      <ErrorNotice error={workflow.error} />
      {workflow.data?.map((item) => (
        <View key={item.id} style={{ gap: 8 }}>
          <Row
            title={item.name}
            caption={stateLabels[item.category]}
            onPress={() => {
              if (canManage) {
                setEditing(item);
                setName(item.name);
                setCategory(item.category);
                setColor(item.color);
                setReassignTo("");
              }
            }}
          />
          {canManage && (
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Button
                title={t("settings.moveUp")}
                compact
                disabled={update.isPending || item.position === 0}
                onPress={() =>
                  update.mutate({
                    projectId,
                    stateId: item.id,
                    expectedVersion: item.version,
                    position: Math.max(0, item.position - 1),
                  })
                }
              />
              <Button
                title={t("settings.moveDown")}
                compact
                disabled={update.isPending}
                onPress={() =>
                  update.mutate({
                    projectId,
                    stateId: item.id,
                    expectedVersion: item.version,
                    position: item.position + 1,
                  })
                }
              />
            </View>
          )}
        </View>
      ))}
      {canManage && (
        <Button
          title={t("settings.workflow.new")}
          onPress={() => {
            setEditing(null);
            setName("");
            setCategory("todo");
            setColor("default");
          }}
        />
      )}
      <Sheet
        title={t("settings.workflow.title")}
        open={editing !== undefined}
        onClose={() => {
          if (!pending) setEditing(undefined);
        }}
      >
        <Field
          label={t("settings.workflow.name")}
          value={name}
          onChangeText={setName}
          maxLength={40}
        />
        <Choice
          label={t("settings.workflow.category")}
          value={category}
          options={states.map((value) => ({ value, label: stateLabels[value] }))}
          onChange={(value) => {
            const next = states.find((item) => item === value);
            if (next) setCategory(next);
          }}
        />
        <Choice
          label={t("settings.workflow.color")}
          value={color}
          onChange={setColor}
          options={projectIconColors.map((value) => ({
            value,
            label: t(`settings.color.${value}`),
          }))}
        />
        <ErrorNotice error={create.error ?? update.error ?? remove.error} />
        <Button
          title={t("common.action.save")}
          primary
          disabled={!name.trim() || pending}
          onPress={() => {
            const fields = { name, category, color: labelColor.parse(color) };
            void (
              editing
                ? update.mutateAsync({
                    projectId,
                    stateId: editing.id,
                    expectedVersion: editing.version,
                    ...fields,
                  })
                : create.mutateAsync({ projectId, ...fields })
            )
              .then(() => setEditing(undefined))
              .catch(() => {});
          }}
        />
        {editing && (
          <>
            <Choice
              label={t("settings.roles.moveTo")}
              value={reassignTo}
              onChange={setReassignTo}
              options={[
                { value: "", label: t("settings.roles.moveTo") },
                ...(workflow.data ?? [])
                  .filter((item) => item.id !== editing.id)
                  .map((item) => ({ value: item.id, label: item.name })),
              ]}
            />
            <Button
              title={t("settings.workflow.delete")}
              danger
              disabled={!reassignTo || pending}
              onPress={() =>
                Alert.alert(
                  t("settings.workflow.deleteTitle", { name: editing.name }),
                  stateLabels[editing.category],
                  [
                    { text: t("common.action.cancel"), style: "cancel" },
                    {
                      text: t("common.action.confirm"),
                      style: "destructive",
                      onPress: () => {
                        void remove
                          .mutateAsync({
                            projectId,
                            stateId: editing.id,
                            expectedVersion: editing.version,
                            reassignTo,
                          })
                          .then(() => setEditing(undefined))
                          .catch(() => {});
                      },
                    },
                  ],
                )
              }
            />
          </>
        )}
      </Sheet>
    </Section>
  );
}

function FieldSettings({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const { api } = useConnection(),
    fields = useQuery(api.query("list_custom_fields", { projectId }));
  const [editing, setEditing] = useState<CustomField | null | undefined>();
  const remove = useOperation("delete_custom_field"),
    move = useOperation("move_custom_field");
  return (
    <Section title={t("settings.fields.title")}>
      <ErrorNotice error={fields.error ?? remove.error ?? move.error} />
      {fields.data?.map((field, index, all) => (
        <View key={field.id}>
          <Row
            title={field.name}
            caption={customFieldTypeLabels[field.type]}
            onPress={() => {
              if (canManage) setEditing(field);
            }}
          />
          {canManage && (
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Button
                title={t("settings.moveUp")}
                compact
                disabled={index === 0 || move.isPending}
                onPress={() => {
                  const before = all[index - 1]?.id;
                  if (before)
                    move.mutate({
                      projectId,
                      fieldId: field.id,
                      expectedVersion: field.version,
                      before,
                    });
                }}
              />
              <Button
                title={t("settings.moveDown")}
                compact
                disabled={index === all.length - 1 || move.isPending}
                onPress={() => {
                  const after = all[index + 1]?.id;
                  if (after)
                    move.mutate({
                      projectId,
                      fieldId: field.id,
                      expectedVersion: field.version,
                      after,
                    });
                }}
              />
              <Button
                title={t("common.action.delete")}
                danger
                compact
                disabled={remove.isPending}
                onPress={() =>
                  Alert.alert(
                    t("settings.fields.deleteNamed", { name: field.name }),
                    t("settings.fields.deleteUsed", { count: field.count }),
                    [
                      { text: t("common.action.cancel"), style: "cancel" },
                      {
                        text: t("common.action.confirm"),
                        style: "destructive",
                        onPress: () =>
                          remove.mutate({
                            projectId,
                            fieldId: field.id,
                            expectedVersion: field.version,
                          }),
                      },
                    ],
                  )
                }
              />
            </View>
          )}
        </View>
      ))}
      {canManage && <Button title={t("settings.fields.new")} onPress={() => setEditing(null)} />}
      <Sheet
        title={t("settings.fields.title")}
        open={editing !== undefined}
        onClose={() => setEditing(undefined)}
      >
        {editing !== undefined && (
          <FieldDefinition
            key={editing?.id ?? "new"}
            projectId={projectId}
            field={editing}
            onSaved={() => setEditing(undefined)}
          />
        )}
      </Sheet>
    </Section>
  );
}

function FieldDefinition({
  projectId,
  field,
  onSaved,
}: {
  projectId: string;
  field: CustomField | null;
  onSaved: () => void;
}) {
  const [name, setName] = useState(field?.name ?? ""),
    [type, setType] = useState<CustomField["type"]>(field?.type ?? "text"),
    [required, setRequired] = useState(field?.required ?? false),
    [options, setOptions] = useState(field?.options ?? []),
    [defaultValue, setDefaultValue] = useState<CustomFieldValue | null>(
      field?.defaultValue ?? null,
    ),
    [newOption, setNewOption] = useState("");
  const [reassign, setReassign] = useState<Record<string, string | null>>({}),
    [error, setError] = useState<unknown>();
  const create = useOperation("create_custom_field"),
    update = useOperation("update_custom_field");
  const pending = create.isPending || update.isPending;
  return (
    <>
      <Field label={t("settings.fields.name")} value={name} onChangeText={setName} maxLength={60} />
      {!field && (
        <Choice
          label={t("settings.fields.type")}
          value={type}
          options={customFieldTypes.map((value) => ({
            value,
            label: customFieldTypeLabels[value],
          }))}
          onChange={(value) => {
            const next = customFieldTypes.find((item) => item === value);
            if (next) {
              setType(next);
              setDefaultValue(null);
            }
          }}
        />
      )}
      <Check label={t("settings.fields.required")} checked={required} onChange={setRequired} />
      {(type === "select" || type === "multiselect") && (
        <Section title={t("settings.fields.options")}>
          {options.map((option) => (
            <View key={option.id} style={{ gap: 8 }}>
              <Field
                label={t("settings.fields.option")}
                value={option.name}
                onChangeText={(value) =>
                  setOptions((previous) =>
                    previous.map((item) =>
                      item.id === option.id ? { ...item, name: value } : item,
                    ),
                  )
                }
              />
              <Button
                title={t("settings.fields.removeOption", { name: option.name })}
                danger
                compact
                onPress={() => {
                  setOptions((previous) => previous.filter((item) => item.id !== option.id));
                  setReassign((previous) => ({ ...previous, [option.id]: null }));
                }}
              />
            </View>
          ))}
          <Field
            label={t("settings.fields.addOption")}
            value={newOption}
            onChangeText={setNewOption}
          />
          <Button
            title={t("settings.fields.addOption")}
            disabled={!newOption.trim()}
            onPress={() => {
              setOptions((previous) => [
                ...previous,
                { id: Crypto.randomUUID(), name: newOption.trim(), color: "gray" },
              ]);
              setNewOption("");
            }}
          />
          {field?.options
            .filter((option) => !options.some((item) => item.id === option.id))
            .map((option) => (
              <Choice
                key={option.id}
                label={t("settings.fields.reassign", { name: option.name })}
                value={reassign[option.id] ?? ""}
                options={[
                  { value: "", label: t("settings.fields.clearValue") },
                  ...options.map((item) => ({ value: item.id, label: item.name })),
                ]}
                onChange={(value) =>
                  setReassign((previous) => ({ ...previous, [option.id]: value || null }))
                }
              />
            ))}
        </Section>
      )}
      <CustomFieldInput
        field={{ name: t("settings.fields.defaultValue"), type, options }}
        value={defaultValue}
        onChange={setDefaultValue}
      />
      <ErrorNotice error={error ?? create.error ?? update.error} />
      <Button
        title={t("common.action.save")}
        primary
        disabled={!name.trim() || pending}
        onPress={() => {
          try {
            const value = parseCustomFieldDraft({ type, options }, defaultValue);
            const promise = field
              ? update.mutateAsync({
                  projectId,
                  fieldId: field.id,
                  expectedVersion: field.version,
                  name,
                  required,
                  options,
                  defaultValue: value,
                  reassign,
                })
              : create.mutateAsync({
                  projectId,
                  name,
                  type,
                  required,
                  options,
                  defaultValue: value,
                });
            void promise.then(onSaved).catch(() => {});
          } catch (cause) {
            setError(cause);
          }
        }}
      />
    </>
  );
}
