REPO=blacktop
NAME=lzfse.js
VERSION=$(shell cat VERSION)
MESSAGE?="New release ${VERSION}"

GIT_COMMIT=$(git rev-parse HEAD)
GIT_DIRTY=$(test -n "`git status --porcelain`" && echo "+CHANGES" || true)
GIT_DESCRIBE=$(git describe --tags)

EMSDK=$(shell http https://raw.githubusercontent.com/emscripten-core/emsdk/master/emscripten-releases-tags.txt | jq '.latest')

CC=/usr/local/opt/emscripten/libexec/llvm/bin/clang

.PHONY: docker
docker:
	docker build --build-arg=EMSCRIPTEN_VERSION=$(EMSDK) -t emscripten/emscripten ./hack/docker

.PHONY: docker-install
docker-install:
	@docker run --rm -v `pwd`:`pwd` -u `id -u`:`id -g` --workdir `pwd` \
	emscripten/emscripten \
	emcc $(PWD)/hello.c -s STANDALONE_WASM

.PHONY: build
build: clean
	@echo " > Building"
	@cd vendor/lzfse; docker run --rm -v `pwd`:`pwd` -u `id -u`:`id -g` --workdir `pwd` \
	emscripten/emscripten \
	emmake make install INSTALL_PREFIX=/tmp/lzfse.dst/usr/local
	@mv vendor/lzfse/build/bin/lzfse vendor/lzfse/build/bin/lzfse.bc
	@docker run --rm -v `pwd`:`pwd` -u `id -u`:`id -g` --workdir `pwd` \
	emscripten/emscripten \
	emcc $(PWD)/vendor/lzfse/build/bin/lzfse.bc -s FORCE_FILESYSTEM=1 -s EXIT_RUNTIME=1 -s ALLOW_MEMORY_GROWTH=1 -s TOTAL_MEMORY=1GB -s ERROR_ON_UNDEFINED_SYMBOLS=0 -s NODERAWFS=1 -O2 -o $(PWD)/public/lzfse.js
	@ls -lah public

.PHONY: run
run: build
	@echo " > Running"
	@node public/lzfse.js -v -decode -i data.bin -o kernelcache.release.iphone12.decompressed
	@file kernelcache.release.iphone12.decompressed

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
	@rm public/* || true

# Absolutely awesome: http://marmelab.com/blog/2016/02/29/auto-documented-makefile.html
help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-30s\033[0m %s\n", $$1, $$2}'

.DEFAULT_GOAL := help