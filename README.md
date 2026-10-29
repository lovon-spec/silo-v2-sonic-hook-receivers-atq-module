# Legacy Silo V2 hook receivers on Sonic

This module emits every hook-receiver contract identified by the Silo entities of the documented legacy Sonic source, chain 146. These contracts are distinct from the configurations, lending vaults, share tokens and incentives controllers.

## Specific source documentation

Silo Finance's own [snapshot documentation](https://github.com/silo-finance/lenders-snapshot/blob/58dbfc612906307137c305d56adf9f1a7ea61dce/scripts/lender-snapshot/README.md)
describes the `subgraph_url` configuration and identifies `snapshot_lenders.py`
as its canonical configuration. That [documented configuration](https://github.com/silo-finance/lenders-snapshot/blob/58dbfc612906307137c305d56adf9f1a7ea61dce/scripts/lender-snapshot/snapshot_lenders.py)
explicitly selects Sonic's subgraph
`8wcbzcdNirQvk1ETh25wpVzb5GWs8DvugpbwrYnTCcxj`. This is a reference to that
specific subgraph, without inferring authorization for other publications by
the same address. The project also identifies these chain endpoints as legacy
V2 sources in its [borrower tooling](https://github.com/silo-finance/actions/blob/0e0a4f79772a176846e181483d1f22adf5b26948/scripts/pull_borrowers/fetch_legacy_borrowers.py).

The [named subgraph](https://thegraph.com/explorer/subgraphs/8wcbzcdNirQvk1ETh25wpVzb5GWs8DvugpbwrYnTCcxj?chain=arbitrum-one&view=About)
resolved on 2026-10-29 to deployment
`QmQUcPAEpUQJL3AYK21hsgNnj6XmWepTXJXySHdFXMmp7p`. The module queries that
explicit deployment through The Graph gateway, with the supplied key only in
the authorization header. Recheck the named source before filing an item.

## Contract category

The project implements this role in [SiloHookV1](https://github.com/silo-finance/silo-contracts-v3/blob/7e2a79e02576978daab075a3fe7668f86de3b58d/silo-core/contracts/utils/hook-receivers/SiloHookV1.sol) and [GaugeHookReceiver](https://github.com/silo-finance/silo-contracts-v3/blob/7e2a79e02576978daab075a3fe7668f86de3b58d/silo-core/contracts/utils/hook-receivers/gauge/GaugeHookReceiver.sol). The receiver is initialized with a Silo configuration. It can handle protocol hooks and notify configured gauges; the tag makes no claim that any gauge or reward program is currently active.

## Retrieval and names

Every Silo row is retrieved with an unfiltered first page, complete ascending unique-address-ID pagination, one block hash and a final metadata seal. Invalid identities, repeated receivers, source errors, unhealthy metadata or unfinished pagination throw. Only rows whose hook receiver is exactly the zero address are omitted: that source value identifies no receiver contract and would produce an invalid contract-address tag. Every nonzero receiver is retained, and no row is padded. Names use actual source Silo IDs with the hook-receiver role. Long names use ellipsis; collisions use the complete emitted address. Notes identify the configuration and both lending vaults.

Each query has a 30-second deadline and the complete run a ten-minute deadline, including pacing and response-body reading. A deadline throws without partial output and requests fetch cancellation. Use Yarn, yarn build and yarn test. All logic is in src/main.mts and exports only async returnTags with exactly two string arguments. MIT licensed, derived from our own original module.
