import { Agent, setGlobalDispatcher } from "undici";
import * as dns from "dns";
import { config } from "../config";
import { TtlCache } from "../tools/cache";

/**
 * DNS alternatif (Cloudflare/Google/OpenDNS) untuk `fetch`, guna melewati pemblokiran DNS oleh ISP.
 * Hanya perlu saat bot dijalankan dari jaringan yang memblokir situs sumber; di VPS biarkan mati.
 */
export function setupDnsResolver(): void {
  if (!config.customDns) return;

  const resolver = new dns.Resolver({ timeout: 3000, tries: 2 });
  resolver.setServers(["1.1.1.1", "8.8.8.8", "208.67.222.222"]);
  const cache = new TtlCache<string, string[]>(5 * 60_000, 500);

  const agent = new Agent({
    connect: {
      lookup: (hostname, opts, cb) => {
        const callback = (typeof opts === "function" ? opts : cb) as (err: Error | null, address?: any, family?: number) => void;
        const options = (typeof opts === "object" ? opts : {}) as { all?: boolean };
        const answer = (addrs: string[]) =>
          options.all ? callback(null, addrs.map((address) => ({ address, family: 4 }))) : callback(null, addrs[0], 4);

        const cached = cache.get(hostname);
        if (cached) return answer(cached);

        resolver.resolve4(hostname, (err, addrs) => {
          if (err || !addrs?.length) return dns.lookup(hostname, options as any, callback as any);
          cache.set(hostname, addrs);
          answer(addrs);
        });
      },
    },
  });

  setGlobalDispatcher(agent);
  console.log("[DNS] Resolver alternatif aktif (1.1.1.1, 8.8.8.8, 208.67.222.222).");
}
