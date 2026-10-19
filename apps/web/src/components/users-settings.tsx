import { UserContextMenu } from "./object-context-menu.tsx";
import { UserPlus, MoreHorizontal } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { auth, api } from "../data.tsx";
import {
  Button,
  ErrorNotice,
  Input,
  Loading,
  EmptyState,
  Modal,
  SectionHeading,
  Select,
  SelectItem,
  RelativeTime,
  SearchField,
  FormActions,
  IconButton,
  Pager,
} from "../ui.tsx";
import { formText } from "../forms.ts";
import { UserIdentity } from "./user-avatar.tsx";
import { AccountDetails } from "./account-details.tsx";
import { accountsSchema } from "@kanvil/contracts/users";
import { hasAdminRole } from "@kanvil/contracts";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { t } from "@kanvil/contracts/i18n";
function AccountAdministration({
  onCreated,
  onCancel,
  pending,
  setPending,
}: {
  onCreated: (id: string, email: string) => void;
  onCancel: () => void;
  pending: boolean;
  setPending: (pending: boolean) => void;
}) {
  const cache = useQueryClient();
  const [error, setError] = useState<unknown>();
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget,
      values = new FormData(form);
    setPending(true);
    setError(undefined);
    try {
      const result = await auth.admin.createUser({
        name: formText(values, "name"),
        email: formText(values, "email"),
        password: formText(values, "password"),
        role: values.get("role") === "admin" ? "admin" : "user",
      });
      if (result.error) throw new Error(result.error.message);
      await cache.invalidateQueries({ queryKey: ["kanvil", "users"] });
      onCreated(result.data.user.id, result.data.user.email);
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  }
  return (
    <section>
      <form
        onSubmit={(event) => {
          void create(event);
        }}
      >
        <Input label={t("admin.users.name")} name="name" required maxLength={120} autoFocus />
        <Input
          label={t("admin.users.email")}
          name="email"
          type="email"
          required
          autoComplete="off"
        />
        <Input
          label={t("admin.users.initialPassword")}
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
          required
        />
        <Select label={t("admin.users.instanceRole")} name="role">
          <SelectItem value="user">{t("admin.users.user")}</SelectItem>
          <SelectItem value="admin">{t("admin.users.administrator")}</SelectItem>
        </Select>
        <FormActions
          error={error}
          pending={pending}
          submitLabel={t("admin.users.create")}
          pendingLabel={t("admin.users.creating")}
          onCancel={onCancel}
        />
      </form>
    </section>
  );
}

export function UsersSettings() {
  const cache = useQueryClient(),
    session = auth.useSession();
  const [creating, setCreating] = useState(false),
    [pending, setPending] = useState(false),
    [query, setQuery] = useState(""),
    [role, setRole] = useState("all"),
    [status, setStatus] = useState("all"),
    [offset, setOffset] = useState(0),
    [selected, setSelected] = useState<string | null>(null);
  const users = useQuery({
    queryKey: ["kanvil", "users", query, role, status, offset],
    queryFn: () =>
      api.request(
        `/api/v1/admin/users?${new URLSearchParams({ q: query, role, status, offset: String(offset), limit: "25" })}`,
        accountsSchema,
      ),
    placeholderData: keepPreviousData,
  });
  async function refresh() {
    await Promise.all([cache.invalidateQueries({ queryKey: ["kanvil"] }), session.refetch()]);
  }
  return (
    <section>
      <SectionHeading
        title={t("admin.users.title")}
        action={
          <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
            <SearchField
              label={t("admin.users.search")}
              placeholder={t("admin.users.searchPlaceholder")}
              value={query}
              onChange={(value) => {
                setQuery(value);
                setOffset(0);
              }}
            />
            <IconButton
              label={t("admin.users.new")}
              variant="default"
              onClick={() => setCreating(true)}
            >
              <UserPlus />
            </IconButton>
          </div>
        }
      />
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <Select
          label={t("admin.users.roleFilter")}
          labelHidden
          className="mb-0 w-40"
          value={role}
          onValueChange={(value) => {
            if (value) setRole(value);
            setOffset(0);
          }}
        >
          <SelectItem value="all">{t("admin.users.allRoles")}</SelectItem>
          <SelectItem value="admin">{t("admin.users.administrators")}</SelectItem>
          <SelectItem value="user">{t("admin.users.users")}</SelectItem>
        </Select>
        <Select
          label={t("admin.users.statusFilter")}
          labelHidden
          className="mb-0 w-40"
          value={status}
          onValueChange={(value) => {
            if (value) setStatus(value);
            setOffset(0);
          }}
        >
          <SelectItem value="all">{t("admin.users.allAccounts")}</SelectItem>
          <SelectItem value="active">{t("admin.users.active")}</SelectItem>
          <SelectItem value="disabled">{t("admin.users.disabled")}</SelectItem>
        </Select>
      </div>
      <ErrorNotice error={users.error} />
      {users.isPending ? (
        <Loading />
      ) : !users.data?.users.length ? (
        <EmptyState
          title={
            query || role !== "all" || status !== "all"
              ? t("admin.users.noMatches")
              : t("admin.users.empty")
          }
          className="py-12"
        />
      ) : (
        <div aria-busy={users.isFetching}>
          <Table mobileLayout="rows" aria-label={t("admin.users.title")}>
            <TableHeader>
              <TableRow>
                <TableHead>{t("admin.users.user")}</TableHead>
                <TableHead>{t("admin.users.role")}</TableHead>
                <TableHead>{t("admin.users.status")}</TableHead>
                <TableHead>{t("admin.users.joined")}</TableHead>
                <TableHead>
                  <span className="sr-only">{t("admin.users.actions")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.data.users.map((person) => (
                <UserContextMenu
                  key={person.id}
                  name={person.name}
                  email={person.email}
                  onOpen={() => setSelected(person.id)}
                >
                  <TableRow>
                    <TableCell className="whitespace-normal">
                      <Button
                        variant="ghost"
                        className="h-auto max-w-full justify-start p-0 text-left hover:bg-transparent"
                        onClick={() => setSelected(person.id)}
                      >
                        <UserIdentity
                          name={person.name}
                          email={person.email}
                          image={person.image}
                        />
                      </Button>
                    </TableCell>
                    <TableCell data-label={t("admin.users.role")}>
                      <Badge variant="secondary">
                        {hasAdminRole(person.role)
                          ? t("admin.users.administrator")
                          : t("admin.users.user")}
                      </Badge>
                    </TableCell>
                    <TableCell data-label={t("admin.users.status")}>
                      <Badge variant={person.banned ? "destructive" : "outline"}>
                        {person.banned ? t("admin.users.disabled") : t("admin.users.active")}
                      </Badge>
                    </TableCell>
                    <TableCell
                      data-label={t("admin.users.joined")}
                      className="text-xs text-muted-foreground"
                    >
                      <RelativeTime value={person.createdAt} />
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t("admin.users.manage", { name: person.name })}
                        onClick={() => setSelected(person.id)}
                      >
                        <MoreHorizontal />
                      </Button>
                    </TableCell>
                  </TableRow>
                </UserContextMenu>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <Pager
        noun={t("admin.users.pagerNoun")}
        offset={offset}
        total={users.data?.total ?? 0}
        size={25}
        onChange={setOffset}
      />
      <Modal
        title={t("admin.users.create")}
        open={creating}
        onOpenChange={setCreating}
        busy={pending}
      >
        <AccountAdministration
          pending={pending}
          setPending={setPending}
          onCancel={() => setCreating(false)}
          onCreated={(id, email) => {
            setCreating(false);
            setQuery("");
            setRole("all");
            setStatus("all");
            setOffset(0);
            setSelected(id);
            toast.success(t("admin.users.created", { email }));
          }}
        />
      </Modal>
      <AccountDetails
        key={selected ?? "closed"}
        userId={selected}
        onClose={() => setSelected(null)}
        onChanged={refresh}
      />
    </section>
  );
}
