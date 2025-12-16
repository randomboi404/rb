name: Validate domain JSON

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  validate:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 2

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Get changed files
        run: |
          git diff --name-only ${{ github.event.pull_request.base.sha }} ${{ github.sha }} > changes.txt

      - name: Validate JSON files
        run: |
          node scripts/validate-json.js
