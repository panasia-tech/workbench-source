export function createRequestGeneration() {
  let requestId = 0
  let revision = 0
  let disposed = false

  return Object.freeze({
    begin() {
      return Object.freeze({ requestId: ++requestId, revision })
    },
    mutate() {
      revision += 1
      return revision
    },
    canApply(token) {
      return !disposed && token?.requestId === requestId && token?.revision === revision
    },
    isLatestRequest(token) {
      return !disposed && token?.requestId === requestId
    },
    dispose() {
      disposed = true
      requestId += 1
    }
  })
}
