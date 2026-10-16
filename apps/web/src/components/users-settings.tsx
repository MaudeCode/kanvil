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
        <Input label="Name" name="name" required maxLength={120} autoFocus />
        <Input label="Email" name="email" type="email" required autoComplete="off" />
        <Input
          label="Initial password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
          required
        />
        <Select label="Instance role" name="role">
          <SelectItem value="user">User</SelectItem>
          <SelectItem value="admin">Administrator</SelectItem>
        </Select>
        <FormActions
          error={error}
          pending={pending}
          submitLabel="Create account"
          pendingLabel="Creating…"
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
        title="Users"
        action={
          <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
            <SearchField
              label="Search users"
              placeholder="Name or email…"
              value={query}
              onChange={(value) => {
                setQuery(value);
                setOffset(0);
              }}
            />
            <IconButton label="New user" variant="default" onClick={() => setCreating(true)}>
              <UserPlus />
            </IconButton>
          </div>
        }
      />
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <Select
          label="Instance role filter"
          labelHidden
          className="mb-0 w-40"
          value={role}
          onValueChange={(value) => {
            if (value) setRole(value);
            setOffset(0);
          }}
        >
          <SelectItem value="all">All roles</SelectItem>
          <SelectItem value="admin">Administrators</SelectItem>
          <SelectItem value="user">Users</SelectItem>
        </Select>
        <Select
          label="Account status filter"
          labelHidden
          className="mb-0 w-40"
          value={status}
          onValueChange={(value) => {
            if (value) setStatus(value);
            setOffset(0);
          }}
        >
          <SelectItem value="all">All accounts</SelectItem>
          <SelectItem value="active">Active</SelectItem>
          <SelectItem value="disabled">Disabled</SelectItem>
        </Select>
      </div>
      <ErrorNotice error={users.error} />
      {users.isPending ? (
        <Loading />
      ) : !users.data?.users.length ? (
        <EmptyState
          title={query || role !== "all" || status !== "all" ? "No matching users" : "No users"}
          className="py-12"
        />
      ) : (
        <div aria-busy={users.isFetching}>
          <Table mobileLayout="rows" aria-label="Users">
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Joined</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
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
                    <TableCell data-label="Role">
                      <Badge variant="secondary">
                        {hasAdminRole(person.role) ? "Administrator" : "User"}
                      </Badge>
                    </TableCell>
                    <TableCell data-label="Status">
                      <Badge variant={person.banned ? "destructive" : "outline"}>
                        {person.banned ? "Disabled" : "Active"}
                      </Badge>
                    </TableCell>
                    <TableCell data-label="Joined" className="text-xs text-muted-foreground">
                      <RelativeTime value={person.createdAt} />
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Manage ${person.name}`}
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
      {((users.data?.total ?? 0) > 25 || offset > 0) && (
        <footer className="mt-5 flex flex-wrap items-center justify-end gap-2 text-xs text-muted-foreground [&>span]:mr-auto">
          <Button disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 25))}>
            Previous users
          </Button>
          <span className="text-xs text-muted-foreground">
            {offset + 1}–{Math.min(offset + 25, users.data?.total ?? 0)} of {users.data?.total}
          </span>
          <Button
            disabled={offset + 25 >= (users.data?.total ?? 0)}
            onClick={() => setOffset(offset + 25)}
          >
            Next users
          </Button>
        </footer>
      )}
      <Modal title="Create account" open={creating} onOpenChange={setCreating} busy={pending}>
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
            toast.success(`Created ${email}`);
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
