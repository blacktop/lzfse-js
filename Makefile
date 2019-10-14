REPO=blacktop
NAME=lzfse-js
VERSION=$(shell cat VERSION)
MESSAGE?="New release ${VERSION}"

GIT_COMMIT=$(git rev-parse HEAD)
GIT_DIRTY=$(test -n "`git status --porcelain`" && echo "+CHANGES" || true)
GIT_DESCRIBE=$(git describe --tags)

EMSDK=$(shell http https://raw.githubusercontent.com/emscripten-core/emsdk/master/emscripten-releases-tags.txt | jq '.latest')

.PHONY: docker
docker:
	docker build --build-arg=EMSCRIPTEN_VERSION=$(EMSDK) -t emscripten/emscripten ./docker

.PHONY: docker-install
docker-install:
	docker run \
	--rm \
	-v `pwd`:`pwd` \
	-u `id -u`:`id -g` \
	emscripten/emscripten \
	emcc helloworld.cpp -o helloworld.js

.PHONY: build
build: clean
	@echo " > Building"
	@emcc helloworld.cpp -s WASM=1 -s BINARYEN=0 -O2 -o public/helloworld.js
	@ls -lah public

.PHONY: run
run: build
	@echo " > Running"
	@node public/helloworld.js

.PHONY: bump
bump: ## Incriment version patch number
	@echo " > Bumping VERSION"
	@hack/bump/version -p $(shell cat VERSION) > VERSION
	@git commit -am "bumping version to $(shell cat VERSION)"
	@git push

.PHONY: release
release: bump ## Create a new release from the VERSION
	@echo " > Creating Release"
	@hack/make/release v$(shell cat VERSION)
	@goreleaser --rm-dist

.PHONY: destroy
destroy: ## Remove release from the VERSION
	@echo " > Deleting Release"
	rm -rf dist
	git tag -d v${VERSION}
	git push origin :refs/tags/v${VERSION}

.PHONY: clean
clean: ## Clean the artifacts
	@echo " > Cleaning"
	@rm public/*

# Absolutely awesome: http://marmelab.com/blog/2016/02/29/auto-documented-makefile.html
help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-30s\033[0m %s\n", $$1, $$2}'

.DEFAULT_GOAL := help