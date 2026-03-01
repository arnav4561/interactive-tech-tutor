import { evaluate } from "mathjs";

type WorkerRequest = {
  ticket: number;
  expressions: Array<{
    expression: string;
    variables?: Record<string, number>;
  }>;
};

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { ticket, expressions } = event.data;
  const lines = expressions.map((item) => {
    try {
      const result = evaluate(item.expression, item.variables ?? {});
      return `${item.expression} = ${String(result)}`;
    } catch (_error) {
      return `${item.expression} = [invalid expression]`;
    }
  });

  self.postMessage({ ticket, lines });
};

