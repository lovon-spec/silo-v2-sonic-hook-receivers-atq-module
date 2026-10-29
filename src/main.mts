import type { ContractTag, ITagService } from "atq-types";

const DEPLOYMENT = "QmQUcPAEpUQJL3AYK21hsgNnj6XmWepTXJXySHdFXMmp7p";
const ENDPOINT = `https://gateway.thegraph.com/api/deployments/id/${DEPLOYMENT}`;
const PAGE_SIZE = 1000;
const MAX_PAGES = 1000;
const QUERY_TIMEOUT_MS = 30_000;
const RUN_TIMEOUT_MS = 600_000;

type Meta = {
  deployment: string;
  hasIndexingErrors: boolean;
  block: { number: number; hash: string };
};
type Silo = {
 id: string; configAddress: string; siloId: string; gaugeHookReceiver: string;
 market1: { id: string }; market2: { id: string };
};

function address(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-f]{40}$/.test(value) &&
    value !== "0x" + "0".repeat(40);
}

function checkedMeta(meta: Meta): Meta {
  if (meta?.deployment !== DEPLOYMENT || meta.hasIndexingErrors !== false ||
      !Number.isSafeInteger(meta.block?.number) || meta.block.number < 1 ||
      !/^0x[0-9a-f]{64}$/.test(meta.block?.hash ?? "")) {
    throw new Error("The Silo V2 source metadata is incomplete or unhealthy.");
  }
  return meta;
}

function sameMeta(meta: Meta, anchor: Meta): void {
  checkedMeta(meta);
  if (meta.block.number !== anchor.block.number || meta.block.hash !== anchor.block.hash) {
    throw new Error("The Silo V2 source snapshot changed.");
  }
}

function toTag(silo: Silo): ContractTag {
  if (!address(silo.id) || !address(silo.configAddress) || !/^0x[0-9a-f]{40}$/.test(silo.gaugeHookReceiver) ||
      !address(silo.market1?.id) || !address(silo.market2?.id) || silo.market1.id === silo.market2.id ||
      !/^(?:0|[1-9][0-9]{0,77})$/.test(silo.siloId)) {
    throw new Error("Invalid Silo hook-receiver identity or paired market.");
  }
  let name = `Silo V2 #${silo.siloId} Hook Receiver`;
  if ([...name].length > 47) name = [...name].slice(0, 44).join("") + "...";
  return {
    "Contract Address": `eip155:146:${silo.gaugeHookReceiver}`,
    "Public Name Tag": name,
    "Project Name": "Silo Finance",
    "UI/Website Link": "https://app.silo.finance/",
    "Public Note": `Silo Finance V2 hook receiver for its paired lending vaults. ` +
      `Silo ID: ${silo.siloId}. Configuration: ${silo.configAddress}. ` +
      `Lending vaults: ${silo.market1.id}, ${silo.market2.id}. ` +
      `Supports protocol hooks and notifications for configured gauges; this tag does not imply active rewards.`,
  };
}

const service: ITagService = {
  returnTags: async (chainId: string, apiKey: string): Promise<ContractTag[]> => {
    if (chainId !== "146") throw new Error(`Unsupported Chain ID: ${chainId}.`);
    if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
      throw new Error("A query-service API key must be supplied.");
    }
    let requests = 0;
    const deadline = Date.now() + RUN_TIMEOUT_MS;
    async function query<T>(request: { query: string; variables?: object }): Promise<T> {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("Silo V2 execution deadline reached.");
      const waitMs = Math.min(QUERY_TIMEOUT_MS, remaining);
      const queryDeadline = Date.now() + waitMs;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          (async () => {
            if (++requests > MAX_PAGES + 2) throw new Error("Silo V2 query limit reached.");
            if (requests > 1) await new Promise<void>(resolve => setTimeout(resolve, 2000));
            if (controller.signal.aborted || Date.now() >= queryDeadline) {
              throw new Error("Silo V2 query deadline reached.");
            }
            const response = await fetch(ENDPOINT, {
              method: "POST",
              redirect: "error",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
              body: JSON.stringify(request),
              signal: controller.signal,
            });
            if (!response.ok) throw new Error(`Silo V2 query failed with HTTP ${response.status}.`);
            const result = await response.json() as { data?: T; errors?: unknown };
            if (Date.now() >= queryDeadline) throw new Error("Silo V2 query deadline reached.");
            if (!result.data || (result.errors !== undefined &&
                (!Array.isArray(result.errors) || result.errors.length > 0))) {
              throw new Error("The Silo V2 query did not return complete data.");
            }
            return result.data;
          })(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new Error("Silo V2 query deadline reached."));
            }, waitMs);
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        controller.abort();
      }
    }

    const anchor = checkedMeta((await query<{ _meta: Meta }>({
      query: "{_meta{deployment hasIndexingErrors block{number hash}}}",
    }))._meta);
    const block = { hash: anchor.block.hash };
    const tags: ContractTag[] = [];
    let cursor: string | null = null;
    let complete = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      const continued = cursor !== null;
      // The first page is unfiltered. Later cursors are actual unique Bytes IDs.
      const data: { silos: Silo[]; _meta: Meta } = await query({
        query: "query Silos(" + (continued ? "$cursor:Bytes!," : "") + "$block:Block_height!){" +
          "silos(first:1000,orderBy:id,orderDirection:asc," +
          (continued ? "where:{id_gt:$cursor}," : "") + "block:$block){" +
          "id siloId configAddress gaugeHookReceiver market1{id} market2{id}}" +
          " _meta(block:$block){deployment hasIndexingErrors block{number hash}}}",
        variables: { ...(continued ? { cursor } : {}), block },
      });
      sameMeta(data._meta, anchor);
      if (!Array.isArray(data.silos) || data.silos.length > PAGE_SIZE) {
        throw new Error("The Silo hook-receiver page is invalid.");
      }
      for (const silo of data.silos) {
        if (!address(silo?.id) || (cursor !== null && silo.id <= cursor)) {
          throw new Error("Silo hook-receiver IDs are repeated or not in cursor order.");
        }
        // A zero receiver is the source's explicit "no hook receiver" value.
        // It cannot yield a contract address. Validate all other row metadata,
        // then omit only this invalid contract-address output, never a real hook.
        const tag = toTag(silo);
        if (silo.gaugeHookReceiver === "0x" + "0".repeat(40)) {
          cursor = silo.id;
          continue;
        }
        if (tags.some(x => x["Contract Address"] === tag["Contract Address"])) {
          throw new Error("A hook receiver belongs to multiple source configurations.");
        }
        tags.push(tag);
        cursor = silo.id;
      }
      if (data.silos.length < PAGE_SIZE) { complete = true; break; }
    }
    // A resource limit throws; it never returns a truncated contract set.
    if (!complete) throw new Error("Silo hook-receiver pagination did not finish.");
    const seal = await query<{ _meta: Meta }>({
      query: "query Seal($block:Block_height!){_meta(block:$block){deployment hasIndexingErrors block{number hash}}}",
      variables: { block },
    });
    sameMeta(seal._meta, anchor);

    const names = new Map<string, number>();
    for (const tag of tags) {
      const name = tag["Public Name Tag"].toLowerCase();
      names.set(name, (names.get(name) ?? 0) + 1);
    }
    // Metadata collisions use the complete source address as the identifier.
    // This retains every vault, without fabricated instance numbers or skips.
    for (const tag of tags) {
      if (names.get(tag["Public Name Tag"].toLowerCase()) !== 1) {
        tag["Public Name Tag"] = "Silo " + tag["Contract Address"].split(":")[2];
      }
    }
    return tags;
  },
};

export async function returnTags(chainId: string, apiKey: string): Promise<ContractTag[]> {
  return service.returnTags(chainId, apiKey);
}
