// Fenced blocks the Markdown renderer upgrades: highlighted code and Mermaid diagrams. Loaded on
// demand, and Mermaid only once a diagram appears.
import { use, useSyncExternalStore, type ReactNode } from "react";
import { errorMessage } from "@kanvil/contracts";
import { highlight, type HighlightNode } from "../lib/highlight.ts";

const spans = (nodes: HighlightNode[]): ReactNode[] =>
  nodes.map((node, index) =>
    node.type === "text" ? (
      node.value
    ) : (
      <span key={index} className={node.className.join(" ")}>
        {spans(node.children)}
      </span>
    ),
  );
function CodeBlock({ language, code }: { language: string; code: string }) {
  const nodes = highlight(code, language);
  return (
    <pre>
      <code className={`hljs language-${language}`}>{nodes ? spans(nodes) : code}</code>
    </pre>
  );
}

// Mermaid keeps global configuration, so diagrams render one at a time with their own theme.
type Diagram = { svg: string } | { error: string };
const diagrams = new Map<string, Promise<Diagram>>();
let queue: Promise<unknown> = Promise.resolve(),
  rendered = 0;
function renderDiagram(source: string, dark: boolean) {
  const key = `${dark ? "dark" : "light"}\n${source}`;
  let diagram = diagrams.get(key);
  if (!diagram) {
    diagram = queue.then(async (): Promise<Diagram> => {
      try {
        const { default: mermaid } = await import("mermaid");
        // Strict mode sanitizes labels and disables scripts and click handlers in the SVG.
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: dark ? "dark" : "neutral",
          fontFamily: "inherit",
        });
        // Mermaid measures labels in a scratch element; inside this container no transition
        // can be mid-flight while it measures, even with the reduced-motion durations.
        const scratch = document.createElement("div");
        scratch.className = "diagram-render";
        document.body.append(scratch);
        try {
          return await mermaid.render(`kanvil-diagram-${++rendered}`, source, scratch);
        } finally {
          scratch.remove();
        }
      } catch (error) {
        return { error: errorMessage(error) };
      }
    });
    queue = diagram;
    if (diagrams.size > 50) diagrams.clear();
    diagrams.set(key, diagram);
  }
  return diagram;
}
// Follows the `dark` class ThemeProvider sets on the document.
function subscribeAppearance(change: () => void) {
  const observer = new MutationObserver(change);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}
const isDark = () => document.documentElement.classList.contains("dark");
function MermaidDiagram({ source }: { source: string }) {
  const diagram = use(renderDiagram(source, useSyncExternalStore(subscribeAppearance, isDark)));
  return (
    <figure className="my-3">
      {"svg" in diagram ? (
        <div
          role="img"
          aria-label="Diagram"
          className="overflow-x-auto [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
          // Mermaid's strict security level returns sanitized SVG.
          dangerouslySetInnerHTML={{ __html: diagram.svg }}
        />
      ) : (
        <p role="alert" className="m-0 text-xs text-destructive">
          This diagram could not be drawn: {diagram.error}
        </p>
      )}
      <details className="mt-1 text-xs text-muted-foreground" open={"error" in diagram}>
        <summary className="cursor-pointer">Diagram source</summary>
        <CodeBlock language="plaintext" code={source} />
      </details>
    </figure>
  );
}
export default function MarkdownBlock({ language, code }: { language: string; code: string }) {
  return language === "mermaid" ? (
    <MermaidDiagram source={code} />
  ) : (
    <CodeBlock language={language} code={code} />
  );
}
