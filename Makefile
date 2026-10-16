# Build the four images, put them in the k3d cluster, install the three releases.
# Local and production differ only by VALUES: `make install VALUES=prod`.
#
#   make up        images + import + install, from nothing to a running demo
#   make e2e       the end-to-end check against what `up` installed

CLUSTER ?= urumi
CONTEXT ?= k3d-$(CLUSTER)
# A hash of everything that goes into the images: changed code gets a new tag, so
# `helm upgrade` rolls it out; unchanged code keeps its tag and its pods.
TAG     ?= $(shell find apps docker pnpm-lock.yaml -type f -not -path '*/node_modules/*' -not -path '*/dist/*' | sort | xargs cat | shasum | cut -c1-12)
VALUES  ?= local

HELM := helm --kube-context $(CONTEXT)
# A gitignored values-secrets.yaml holds the LLM key. Chat is off without it.
SECRETS := $(wildcard values-secrets.yaml)
EXTRA   := $(if $(SECRETS),-f $(SECRETS),)

IMAGES := gateway woo-mcp toolbox-mcp everything
REFS   := $(foreach i,$(IMAGES),urumi/$(i):$(TAG))

.PHONY: up down images import install e2e check lint cluster typecheck $(IMAGES)

up: images import install

# One at a time: the machine has ~4 GB for Docker and the gateway image runs Vite.
# Vite does not type-check, so a broken page would otherwise build fine and ship.
images: typecheck $(IMAGES)

typecheck:
	pnpm -r typecheck
$(IMAGES):
	docker build -f docker/$@.Dockerfile -t urumi/$@:$(TAG) .

import:
	k3d image import $(REFS) -c $(CLUSTER)

# Store and upstreams first: the gateway's seeded upstream credentials are read out
# of their Secrets with `lookup`, so those Secrets have to exist already.
install:
	$(HELM) upgrade --install store charts/store -n store --create-namespace \
	  -f charts/store/values-$(VALUES).yaml --set wooMcp.image.tag=$(TAG) --wait --timeout 15m
	$(HELM) upgrade --install upstreams charts/upstreams -n upstreams --create-namespace \
	  -f charts/upstreams/values-$(VALUES).yaml \
	  --set servers.everything.image.tag=$(TAG) --set servers.toolbox.image.tag=$(TAG) --wait --timeout 5m
	$(HELM) upgrade --install platform charts/platform -n platform --create-namespace \
	  -f charts/platform/values-$(VALUES).yaml $(EXTRA) --set gateway.image.tag=$(TAG) --wait --timeout 5m

down:
	-$(HELM) uninstall platform -n platform
	-$(HELM) uninstall upstreams -n upstreams
	-$(HELM) uninstall store -n store

e2e:
	KUBE_CONTEXT=$(CONTEXT) scripts/e2e.sh

check: lint typecheck
	pnpm -r test

lint:
	@for c in store upstreams platform; do \
	  helm lint charts/$$c -f charts/$$c/values-$(VALUES).yaml || exit 1; \
	done

# Only if the shared cluster is gone: `k3d cluster list` first.
cluster:
	k3d cluster create --config scripts/k3d.yaml
