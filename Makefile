CONTAINER=rocketarb
#REPO=<docker-hub-username>/$(CONTAINER)
REPO=$(CONTAINER)
PLATFORMS=linux/arm64,linux/amd64
VER_MAJOR=$(shell echo ${VERSION} | awk -F'.' '{print $$1}')
VER_MINOR=$(shell echo ${VERSION} | awk -F'.' '{print $$2}')

.PHONY: docker-build docker-publish docker-prepare clean  check-env

docker-prepare:
	docker run --rm --privileged multiarch/qemu-user-static --reset -p yes
	docker buildx create --name multiarch --driver docker-container
	docker buildx inspect --builder multiarch --bootstrap

docker-publish: check-env
	docker buildx build --builder multiarch --platform $(PLATFORMS) \
		-t $(REPO):latest -t $(REPO):$(VERSION) \
		--push .

docker-build: check-env
	$(eval PLATFORMS=linux/amd64)
	docker buildx build --builder multiarch --platform $(PLATFORMS) \
		-t $(REPO):latest \
		--load \
		.
clean:
	docker buildx --builder multiarch prune

check-env:
ifndef VERSION
	$(error VERSION env variable is undefined)
endif
