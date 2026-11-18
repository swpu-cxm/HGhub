import assert from "node:assert/strict";
import {
  groupDownloadTasks,
  groupKey,
  reconcileTasksClient,
  type DownloadTask,
} from "./libraryCache";

function task(partial: Partial<DownloadTask> & Pick<DownloadTask, "id" | "title">): DownloadTask {
  return {
    kind: "hlsMpegTs",
    state: "completed",
    bytesDone: 1,
    speedBps: 0,
    ...partial,
  };
}

const legacyEp2 = task({
  id: "legacy-2",
  title: "琼明神女录",
  episodeIndex: 2,
  episodeLabel: "第 2 集",
});
const newEp3 = task({
  id: "new-3",
  title: "琼明神女录",
  pluginId: "huangguo",
  mediaId: "media-abc",
  episodeIndex: 3,
  episodeCount: 6,
});

const reconciled = reconcileTasksClient([legacyEp2, newEp3]);
assert.equal(reconciled[0].mediaId, "media-abc");
assert.equal(reconciled[0].pluginId, "huangguo");

const groups = groupDownloadTasks(reconciled);
assert.equal(groups.length, 1);
assert.equal(groups[0].tasks.length, 2);
assert.equal(groupKey(reconciled[0]), groupKey(newEp3));

const ambiguous = reconcileTasksClient([
  task({ id: "a", title: "同名剧" }),
  task({ id: "b", title: "同名剧", pluginId: "p1", mediaId: "m1" }),
  task({ id: "c", title: "同名剧", pluginId: "p2", mediaId: "m2" }),
]);
assert.equal(ambiguous[0].mediaId, undefined);
assert.equal(groupDownloadTasks(ambiguous).length, 3);

console.log("libraryCache grouping tests passed");