import assert from "node:assert/strict";
import test from "node:test";
import type { ReadyVideo } from "../../src/lib/readyToSend";
import { deliveryReadyMessage } from "../../src/lib/deliveryReadyMessage";
const cut = {
  submissionId: "cut1", projectId: "project1", uploadFingerprint: "file1",
  destinationFingerprint: "destination1", deliveryDestination: "aryeo-listing",
  street: "893 S Matlack St", clientName: "Fixture client", cutLabel: "Branding video 1",
  round: 2, file: { source: "topaz-1080p", fileName: "final.mp4", downloadHref: "/api/download/cut1" },
  aryeoUrl: "https://aryeo.example/listing", uploaded: null,
} as ReadyVideo;
const plan = (v = cut) => deliveryReadyMessage(v, "https://hub.example");
test("ready approved Aryeo file directs both explicit confirmations", () => {
  assert.match(plan().slackDm, /Upload this video to Aryeo now/);
  assert.match(plan().slackDm, /Mark as Uploaded/);
  assert.match(plan().slackDm, /Mark as sent/);
  assert.match(plan().slackDm, /https:\/\/hub.example\/#video-review/);
  assert.match(plan().slackDm, /version 2/);
});
test("repeated cron uses identical notification key", () => assert.equal(plan().dedupeKey, plan().dedupeKey));
test("changed file or destination gets a fresh notification", () => {
  assert.notEqual(plan().dedupeKey, plan({...cut,uploadFingerprint:"file2"}).dedupeKey);
  assert.notEqual(plan().dedupeKey, plan({...cut,destinationFingerprint:"destination2"}).dedupeKey);
});
test("uploaded stage asks to send, never upload again", () => {
  const p=plan({...cut,uploaded:{id:"receipt1",at:"now",by:"Kyle"}});
  assert.match(p.slackDm,/uploaded but not sent/);
  assert.doesNotMatch(p.slackDm,/Upload this video|Download:/);
  assert.notEqual(p.dedupeKey,plan().dedupeKey);
});
test("portal destination preserves release and access gates", () => {
  const p=plan({...cut,deliveryDestination:"client-portal",monthlyProgram:true});
  assert.match(p.slackDm,/client's portal/);
  // Oct 5: it no longer asks for a "final check" no screen offers.
  assert.doesNotMatch(p.slackDm,/final check|Upload this video to Aryeo|Mark as Uploaded|Aryeo listing:/);
});
test("portal client not live: send the Final Dropbox link, then Mark as sent", () => {
  const p=plan({...cut,deliveryDestination:"client-portal",monthlyProgram:true,file:{...cut.file,dropboxUrl:"https://www.dropbox.com/home/Final?preview=final.mp4"},
    portalStep:{action:"send-outside-portal",blocked:false,says:"Fixture client's portal isn't live yet. Send the Final Dropbox link to Fixture client, then Mark as sent."}} as ReadyVideo);
  assert.match(p.slackDm,/Send the Final Dropbox link to Fixture client, then Mark as sent/);
  assert.match(p.slackDm,/Final Dropbox file: https:\/\/www.dropbox.com/);
  assert.notEqual(p.dedupeKey,plan({...cut,deliveryDestination:"client-portal",monthlyProgram:true}).dedupeKey);
});
test("portal video without its checked 1080p file names the retry and offers no download", () => {
  const p=plan({...cut,deliveryDestination:"client-portal",monthlyProgram:true,
    portalStep:{action:"retry-1080p",blocked:true,says:"The 1080p pass didn't finish: Topaz said no."}} as ReadyVideo);
  assert.match(p.title,/1080p file needed/);
  assert.match(p.slackDm,/Retry 1080p/);
  assert.doesNotMatch(p.slackDm,/Download:|editor's export is the deliverable|final check/);
});
test("monthly branding explicitly switched to Aryeo uses upload workflow", () => {
  assert.match(plan({...cut,monthlyProgram:true}).slackDm,/Upload this video to Aryeo now/);
});
