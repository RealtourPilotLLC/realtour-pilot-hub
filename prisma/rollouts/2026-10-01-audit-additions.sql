-- CreateTable
CREATE TABLE "FinalRenditionCheck" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "destinationMediaId" TEXT NOT NULL,
    "destinationUrl" TEXT NOT NULL,
    "sourceFingerprint" TEXT NOT NULL,
    "checksJson" TEXT NOT NULL,
    "metadataJson" TEXT,
    "checkedBy" TEXT NOT NULL,
    "checkedByUserId" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinalRenditionCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryFollowUpHealth" (
    "lane" TEXT NOT NULL,
    "lastSuccessAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryFollowUpHealth_pkey" PRIMARY KEY ("lane")
);

-- CreateTable
CREATE TABLE "ClientBrandReceipt" (
    "id" TEXT NOT NULL,
    "changeId" TEXT NOT NULL,
    "editorKey" TEXT NOT NULL,
    "requiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ackAt" TIMESTAMP(3),
    "ackBy" TEXT,
    "overrideAt" TIMESTAMP(3),
    "overrideBy" TEXT,
    "overrideReason" TEXT,

    CONSTRAINT "ClientBrandReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShootBriefRead" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "readerUserId" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "snapshotJson" TEXT NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShootBriefRead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EditorBriefReceipt" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "outputId" TEXT NOT NULL,
    "editorKey" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "snapshotJson" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "actorName" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EditorBriefReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FinalRenditionCheck_submissionId_checkedAt_idx" ON "FinalRenditionCheck"("submissionId", "checkedAt");

-- CreateIndex
CREATE INDEX "FinalRenditionCheck_destination_destinationMediaId_idx" ON "FinalRenditionCheck"("destination", "destinationMediaId");

-- CreateIndex
CREATE INDEX "ClientBrandReceipt_editorKey_ackAt_idx" ON "ClientBrandReceipt"("editorKey", "ackAt");

-- CreateIndex
CREATE UNIQUE INDEX "ClientBrandReceipt_changeId_editorKey_key" ON "ClientBrandReceipt"("changeId", "editorKey");

-- CreateIndex
CREATE INDEX "ShootBriefRead_projectId_readerUserId_readAt_idx" ON "ShootBriefRead"("projectId", "readerUserId", "readAt");

-- CreateIndex
CREATE INDEX "EditorBriefReceipt_projectId_editorKey_acceptedAt_idx" ON "EditorBriefReceipt"("projectId", "editorKey", "acceptedAt");

-- CreateIndex
CREATE UNIQUE INDEX "EditorBriefReceipt_outputId_editorKey_digest_key" ON "EditorBriefReceipt"("outputId", "editorKey", "digest");

-- AddForeignKey
ALTER TABLE "FinalRenditionCheck" ADD CONSTRAINT "FinalRenditionCheck_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "ReviewSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientBrandReceipt" ADD CONSTRAINT "ClientBrandReceipt_changeId_fkey" FOREIGN KEY ("changeId") REFERENCES "ClientBrandChange"("id") ON DELETE CASCADE ON UPDATE CASCADE;

