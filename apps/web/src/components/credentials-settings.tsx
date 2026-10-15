import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { credentialsSchema, createdCredentialSchema, okSchema, scopes } from "@kanvil/contracts";
import { api, date, useProjects } from "../data.tsx";
import { Button, Check, Confirm, ErrorNotice, Input } from "../ui.tsx";
import { FieldSet, FieldLegend } from "@/components/ui/field";
import { DatePicker, credentialExpiry } from "./date-picker.tsx";
import { copyText } from "../lib/browser.ts";
export function Credentials() {
  const cache = useQueryClient(),
    projects = useProjects();
  const credentials = useQuery({
    queryKey: ["kanvil", "credentials"],
    queryFn: () => api.request("/api/v1/credentials", credentialsSchema),
  });
  const [expiresAt, setExpiresAt] = useState(() => {
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + 90);
    return expiry;
  });
  const [error, setError] = useState<unknown>(),
    [key, setKey] = useState(""),
    [pending, setPending] = useState(false);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    setError(undefined);
    setPending(true);
    setKey("");
    try {
      const result = await api.request("/api/v1/credentials", createdCredentialSchema, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: values.get("name"),
          projectIds: values.getAll("projects"),
          scopes: values.getAll("scopes"),
          expiresIn: credentialExpiry(expiresAt),
        }),
      });
      setKey(result.key);
      await cache.invalidateQueries({ queryKey: ["kanvil", "credentials"] });
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  }
  return (
    <section>
      <h2>Agent credentials</h2>
      <p className="muted">Credentials inherit your project role and the selected restrictions.</p>
      <ErrorNotice error={credentials.error ?? error} />
      {credentials.data?.map((credential) => (
        <div className="resource-row" key={credential.id}>
          <span>
            {credential.name}
            <small className="muted">
              {" "}
              {credential.start}… ·{" "}
              {credential.expiresAt ? `Expires ${date(credential.expiresAt)}` : "No expiry"}
            </small>
          </span>
          <Confirm
            label="Revoke"
            description={`Revoke ${credential.name ?? "this credential"} immediately?`}
            onConfirm={async () => {
              await api.request(
                `/api/v1/credentials/${encodeURIComponent(credential.id)}`,
                okSchema,
                { method: "DELETE" },
              );
              await cache.invalidateQueries({ queryKey: ["kanvil", "credentials"] });
            }}
          />
        </div>
      ))}
      <form
        onSubmit={(event) => {
          void create(event);
        }}
      >
        <Input label="Credential name" name="name" required maxLength={100} />
        <FieldSet className="mb-5">
          <FieldLegend variant="label">Projects</FieldLegend>
          {projects.data?.map((project) => (
            <Check key={project.id} label={project.name} name="projects" value={project.id} />
          ))}
        </FieldSet>
        <FieldSet className="mb-5">
          <FieldLegend variant="label">Permissions</FieldLegend>
          {scopes.map((scope) => (
            <Check
              key={scope}
              label={scope}
              name="scopes"
              value={scope}
              defaultChecked={scope === "read"}
            />
          ))}
        </FieldSet>
        <DatePicker label="Expires on" value={expiresAt} onChange={setExpiresAt} />
        <Button type="submit" disabled={pending}>
          Create credential
        </Button>
      </form>
      {key && (
        <div className="secret" role="status">
          <p>Copy this credential now. It will not be shown again.</p>
          <Input
            label="New credential"
            value={key}
            readOnly
            onFocus={(event) => event.target.select()}
          />
          <Button
            onClick={() => {
              void copyText(key).catch(setError);
            }}
          >
            Copy
          </Button>
          <Button onClick={() => setKey("")}>Dismiss</Button>
        </div>
      )}
    </section>
  );
}
