ALTER TABLE "Run" ADD COLUMN "notebookLmNotebookId" TEXT;

CREATE UNIQUE INDEX "Run_notebookLmNotebookId_key" ON "Run"("notebookLmNotebookId");
