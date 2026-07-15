<template>
    <!-- begin::sidebar settings -->
	<div class="sidebar" id="settings">
		<header>
			<i class="ti-settings"></i> تنظیمات
		</header>
		<div class="p-4">
			<div class="mb-3">
				<h6 class="text-uppercase font-size-11 mb-3 text-muted">سیستم</h6>
				<ul class="list-group list-group-flush">
					<li class="list-group-item d-flex justify-content-between p-l-r-0 p-t-b-5">
						<span>آپدیت خودکار</span>
						<div class="custom-control custom-switch">
							<input type="checkbox" class="custom-control-input" id="customSwitch1" checked>
							<label class="custom-control-label" for="customSwitch1"></label>
						</div>
					</li>

				</ul>
			</div>
			<div class="mb-3">
				<h6 class="text-uppercase font-size-11 mb-3 text-muted">اطلاعات کاربری</h6>
				<ul class="list-group list-group-flush">
					<li class="list-group-item d-flex justify-content-between p-l-r-0 p-t-b-10">
						<a href="#" @click.prevent="goTo('/settings/changePassword')">تغییر رمز عبور</a>
					</li>
					<li class="list-group-item d-flex justify-content-between p-l-r-0 p-t-b-10">
						<a href="#" @click.prevent="goTo('/settings/userProfile')">ویرایش اطلاعات پروفایل</a>
					</li>
					<li class="list-group-item d-flex justify-content-between p-l-r-0 p-t-b-10">
						<span>اطلاع رسانی ورود</span>
						<div class="custom-control custom-switch">
							<input type="checkbox" class="custom-control-input" id="customSwitch7">
							<label class="custom-control-label" for="customSwitch7"></label>
						</div>
					</li>
				</ul>
			</div>
		</div>
	</div>
	<!-- end::sidebar settings -->
</template>
<script>
export default {
  methods:{
    goTo(path){
      // $('#userProfile').collapse('hide');
      $('#settings').collapse('hide');
      $('.overlay').removeClass('show');
      this.$router.push(path);
    }
  }
}
</script>
