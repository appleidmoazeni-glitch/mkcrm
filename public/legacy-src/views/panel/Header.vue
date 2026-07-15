<template>
    <!-- begin::header -->
	<div class="header">
		<!-- begin::header logo -->
		<div class="header-logo">
			<a href="admin">
				<img class="large-logo" src="/admin/assets/media/image/logo.png" alt="image">
				<img class="small-logo" src="/admin/assets/media/image/logo-sm.png" alt="image">
				<img class="dark-logo" src="/admin/assets/media/image/logo-dark.png" alt="image">
			</a>
		</div>
		<!-- end::header logo -->
		<!-- begin::header body -->
		<div class="header-body">

			<div class="header-body-left">
				<h3 class="page-title">داشبورد</h3>
			</div>

			<div class="header-body-right">
				<!-- begin::navbar main body -->
				<ul class="navbar-nav">
<!--					<li class="nav-item">-->
<!--						<form>-->
<!--							<div class="input-group">-->
<!--								<input type="text" class="form-control" placeholder="جستجو">-->
<!--								<div class="input-group-append">-->
<!--									<button class="btn btn-light" type="button">-->
<!--										<i class="ti-search"></i>-->
<!--									</button>-->
<!--								</div>-->
<!--							</div>-->
<!--						</form>-->
<!--					</li>-->
					
					<li class="nav-item dropdown">
						<a href="#" class="nav-link bg-none" data-sidebar-open="#userProfile">
							<div>
								<figure class="avatar avatar-state-success avatar-sm">
									<img :src="'/'+(user.avatar||(user.gender?'admin/assets/media/image/avatar-m.jpg' : 'admin/assets/media/image/avatar-f.jpg'))" class="rounded-circle" alt="image">
								</figure>
							</div>
						</a>
					</li>
				</ul>
				<!-- end::navbar main body -->

				<div class="d-flex align-items-center">
					<!-- begin::navbar navigation toggler -->
					<div class="d-xl-none d-lg-none d-sm-block navigation-toggler">
						<a href="#">
							<i class="ti-menu"></i>
						</a>
					</div>
					<!-- end::navbar navigation toggler -->

					<!-- begin::navbar toggler -->
					<div class="d-xl-none d-lg-none d-sm-block navbar-toggler">
						<a href="#" class="nav-link" data-sidebar-open="#userProfile">
							<i class="ti-settings"></i>
						</a>
					</div>
					<!-- end::navbar toggler -->
				</div>
			</div>

		</div>
		<!-- end::header body -->

	</div>
	<!-- end::header -->
</template>
<script>
import {mapState} from 'vuex';
// import Hammer from 'hammerjs'
export default {
	computed: mapState(['user']),
	mounted(){
		// if( $(window).width() < 992 ){
		// 	let header = document.querySelector("body");
		// 	var mc = new Hammer(header);
		// 	let panleft = 0;
		// 	mc.on("panleft panright tap press", function(ev) {
		// 			if ( ev.type == "panleft" && !$('.navigation').hasClass('open') ){
		// 				panleft++;
		// 			}else{
		// 				panleft = 0;
		// 			}
		// 			if( panleft == 10 ){
		// 				$('.navigation').toggleClass('open');
		// 				$.createOverlay();
		// 				return false;
		// 			}
		// 	});
		// 	$(document).on('click', '.navigation-toggler', function () {
		// 		panleft = 0;
		// 	});
		// }
	}
}
</script>
<style>
.small-logo{width: 54px!important;}
</style>